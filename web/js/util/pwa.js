'use strict';
(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const LAST_AUTO_RELOAD_KEY = 'k4.pwa.lastAutoReloadAt';
  const JUST_UPDATED_KEY = 'k4.pwa.justUpdated';

  function safeSessionStorage() {
    try {
      return typeof globalThis !== 'undefined' && globalThis.sessionStorage
        ? globalThis.sessionStorage
        : null;
    } catch (_) {
      return null;
    }
  }

  function sessGet(storage, key) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    try {
      return storage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function sessSet(storage, key, val) {
    if (!storage || typeof storage.setItem !== 'function') return;
    try {
      storage.setItem(key, val);
    } catch (_) {}
  }

  function sessRemove(storage, key) {
    if (!storage || typeof storage.removeItem !== 'function') return;
    try {
      storage.removeItem(key);
    } catch (_) {}
  }

  class PwaManager {
    static isEligibleLocation(loc) {
      if (!loc || !loc.protocol) return false;
      if (loc.protocol === 'https:') return true;
      if (loc.protocol === 'http:') {
        const host = String(loc.hostname || '').toLowerCase();
        return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
      }
      return false;
    }

    static isStandalone(win, nav) {
      try {
        if (win && typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches) {
          return true;
        }
      } catch (_) {}
      return Boolean(nav && nav.standalone === true);
    }

    constructor(opts = {}) {
      this._swUrl = opts.swUrl || './sw.js';
      this._scope = opts.scope || './';
      this._checkIntervalMs = Number.isFinite(opts.checkIntervalMs) ? opts.checkIntervalMs : 5 * 60 * 1000;
      this._minCheckGapMs = Number.isFinite(opts.minCheckGapMs) ? opts.minCheckGapMs : 30 * 1000;
      this._reloadGuardMs = Number.isFinite(opts.reloadGuardMs) ? opts.reloadGuardMs : 30 * 1000;
      this._connectedCountdownSec = Number.isFinite(opts.connectedCountdownSec) ? opts.connectedCountdownSec : 5;
      this._disconnectedReloadDelayMs = Number.isFinite(opts.disconnectedReloadDelayMs)
        ? opts.disconnectedReloadDelayMs
        : 350;
      this._initialCheckDelayMs = Number.isFinite(opts.initialCheckDelayMs) ? opts.initialCheckDelayMs : 3000;

      this._isTxBusy = typeof opts.isTxBusy === 'function' ? opts.isTxBusy : () => false;
      this._isConnected = typeof opts.isConnected === 'function' ? opts.isConnected : () => false;
      this._onBeforeReload = typeof opts.onBeforeReload === 'function' ? opts.onBeforeReload : null;
      this._onUpdateState = typeof opts.onUpdateState === 'function' ? opts.onUpdateState : null;
      this._onNotify = typeof opts.onNotify === 'function' ? opts.onNotify : null;

      this._nav = 'navigator' in opts ? opts.navigator : (typeof navigator !== 'undefined' ? navigator : null);
      this._win = 'window' in opts ? opts.window : (typeof window !== 'undefined' ? window : null);
      this._doc = 'document' in opts ? opts.document : (typeof document !== 'undefined' ? document : null);
      this._loc = 'location' in opts ? opts.location : (typeof location !== 'undefined' ? location : null);
      this._sess = 'sessionStorage' in opts ? opts.sessionStorage : safeSessionStorage();
      this._nowFn = typeof opts.nowFn === 'function' ? opts.nowFn : () => Date.now();
      this._MessageChannel =
        'MessageChannel' in opts
          ? opts.MessageChannel
          : (typeof MessageChannel !== 'undefined' ? MessageChannel : null);
      this._reloadFn =
        typeof opts.reloadFn === 'function'
          ? opts.reloadFn
          : () => {
              if (this._loc && typeof this._loc.reload === 'function') {
                this._loc.reload();
              } else if (this._win && this._win.location && typeof this._win.location.reload === 'function') {
                this._win.location.reload();
              }
            };

      this._started = false;
      this._destroyed = false;
      this._supported = false;
      this._swRegistered = false;
      this._swActive = false;
      this._reg = null;
      this._registerPromise = null;
      this._hadControllerAtStart = false;
      this._deferredPrompt = null;
      this._justUpdated = false;
      this._updateReady = false;
      this._updateInfo = null;
      this._changedUrls = [];
      this._userDeferred = false;
      this._reloadingStarted = false;
      this._phase = 'idle';
      this._countdownSec = 0;
      this._lastCheckAt = -Infinity;

      this._intervalId = null;
      this._countdownTimer = null;
      this._reloadTimer = null;
      this._initialCheckTimer = null;
      this._cleanups = [];

      this._audioPlaying = false;
      this._wakeLockSentinel = null;
      this._wakeLockRequesting = false;
      this._wakeLockReleaseCleanup = null;
    }

    _listen(target, type, fn, options) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, fn, options);
      this._cleanups.push(() => {
        if (typeof target.removeEventListener === 'function') {
          target.removeEventListener(type, fn, options);
        }
      });
    }

    _notify(msg, level = 'info') {
      if (this._onNotify) {
        try {
          this._onNotify(msg, level);
        } catch (_) {}
      }
    }

    _emitState() {
      if (this._onUpdateState && !this._destroyed) {
        try {
          this._onUpdateState(this.getStatus());
        } catch (_) {}
      }
    }

    _clearCountdownTimer() {
      if (this._countdownTimer !== null) {
        clearInterval(this._countdownTimer);
        this._countdownTimer = null;
      }
    }

    _clearReloadTimer() {
      if (this._reloadTimer !== null) {
        clearTimeout(this._reloadTimer);
        this._reloadTimer = null;
      }
    }

    _clearTimers() {
      this._clearCountdownTimer();
      this._clearReloadTimer();
      if (this._intervalId !== null) {
        clearInterval(this._intervalId);
        this._intervalId = null;
      }
      if (this._initialCheckTimer !== null) {
        clearTimeout(this._initialCheckTimer);
        this._initialCheckTimer = null;
      }
    }

    _isLoopGuarded() {
      const raw = sessGet(this._sess, LAST_AUTO_RELOAD_KEY);
      if (!raw) return false;
      const lastAt = Number(raw);
      if (!Number.isFinite(lastAt)) return false;
      const delta = this._nowFn() - lastAt;
      return delta >= 0 && delta < this._reloadGuardMs;
    }

    start() {
      if (this._started || this._destroyed) return;
      this._started = true;

      if (sessGet(this._sess, JUST_UPDATED_KEY)) {
        sessRemove(this._sess, JUST_UPDATED_KEY);
        this._justUpdated = true;
        this._notify('Updated to latest version', 'success');
      }

      if (this._win) {
        this._listen(this._win, 'beforeinstallprompt', (e) => {
          if (e && typeof e.preventDefault === 'function') e.preventDefault();
          this._deferredPrompt = e;
          this._emitState();
        });
        this._listen(this._win, 'appinstalled', () => {
          this._deferredPrompt = null;
          this._emitState();
        });
      }

      if (this._doc) {
        this._listen(this._doc, 'visibilitychange', () => {
          if (this._destroyed) return;
          this._reconcileWakeLock();
          if (!this._supported) return;
          if (this._doc.visibilityState !== 'visible') return;
          if (this._updateReady && this._userDeferred && !this._isTxBusy() && !this._isConnected()) {
            this._reconcileUpdatePhase();
            return;
          }
          void this.checkForUpdate();
        });
      }

      const sw = this._nav && this._nav.serviceWorker;
      const eligible = PwaManager.isEligibleLocation(this._loc) && Boolean(sw && typeof sw.register === 'function');
      if (!eligible) {
        this._supported = false;
        this._reconcileWakeLock();
        this._emitState();
        return;
      }

      this._supported = true;
      this._hadControllerAtStart = Boolean(sw.controller);
      this._reconcileWakeLock();

      this._listen(sw, 'controllerchange', () => {
        if (this._destroyed) return;
        if (!this._hadControllerAtStart) {
          this._hadControllerAtStart = true;
          this._swActive = true;
          this._emitState();
          return;
        }
        this._handleUpdateReady({ reason: 'sw-updated', changedUrls: ['./sw.js'] });
      });

      this._listen(sw, 'message', (ev) => {
        if (this._destroyed) return;
        const data = ev && ev.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'K4_SW_UPDATE_READY') {
          this._handleUpdateReady(data);
        }
      });

      if (this._win) {
        this._listen(this._win, 'online', () => {
          if (this._destroyed) return;
          void this.checkForUpdate();
        });
      }

      try {
        this._registerPromise = Promise.resolve(
          sw.register(this._swUrl, { scope: this._scope, updateViaCache: 'none' })
        )
          .then((reg) => {
            if (this._destroyed || !reg) return reg;
            this._reg = reg;
            this._swRegistered = true;
            this._swActive = Boolean(sw.controller || reg.active);

            const watchWorker = (worker) => {
              if (!worker || typeof worker.addEventListener !== 'function') return;
              const onState = () => {
                if (this._destroyed) return;
                if (worker.state === 'installed' && sw.controller && this._hadControllerAtStart) {
                  if (typeof worker.postMessage === 'function') {
                    worker.postMessage({ type: 'K4_SW_SKIP_WAITING' });
                  }
                } else if (worker.state === 'activated') {
                  this._swActive = true;
                  this._emitState();
                }
              };
              worker.addEventListener('statechange', onState);
              this._cleanups.push(() => {
                if (typeof worker.removeEventListener === 'function') {
                  worker.removeEventListener('statechange', onState);
                }
              });
            };

            if (reg.waiting && sw.controller && this._hadControllerAtStart && typeof reg.waiting.postMessage === 'function') {
              reg.waiting.postMessage({ type: 'K4_SW_SKIP_WAITING' });
            }
            if (reg.installing) {
              watchWorker(reg.installing);
            }
            this._listen(reg, 'updatefound', () => {
              if (this._destroyed) return;
              if (reg.installing) watchWorker(reg.installing);
            });

            if (this._checkIntervalMs > 0) {
              this._intervalId = setInterval(() => {
                if (!this._destroyed) void this.checkForUpdate();
              }, this._checkIntervalMs);
            }

            this._emitState();

            if (sw.ready) {
              Promise.resolve(sw.ready)
                .then(() => {
                  if (this._destroyed) return;
                  this._swActive = Boolean(sw.controller || reg.active);
                  this._emitState();
                  if (this._hadControllerAtStart && this._initialCheckDelayMs >= 0) {
                    this._initialCheckTimer = setTimeout(() => {
                      this._initialCheckTimer = null;
                      if (!this._destroyed) void this.checkForUpdate({ force: true });
                    }, this._initialCheckDelayMs);
                  }
                })
                .catch(() => {});
            }

            return reg;
          })
          .catch(() => {
            this._swRegistered = false;
            this._emitState();
            return null;
          });
      } catch (_) {
        this._swRegistered = false;
        this._emitState();
      }

      this._emitState();
    }

    async checkForUpdate(opts = {}) {
      const force = Boolean(opts && opts.force);
      if (this._destroyed || !this._supported) {
        return { status: 'unsupported', changedUrls: [] };
      }
      if (this._registerPromise) {
        await this._registerPromise;
      }
      if (this._destroyed || !this._reg) {
        return { status: 'unsupported', changedUrls: [] };
      }
      if (this._nav && this._nav.onLine === false) {
        return { status: 'offline', changedUrls: [] };
      }
      const now = this._nowFn();
      if (!force && now - this._lastCheckAt < this._minCheckGapMs) {
        return {
          status: this._updateReady ? 'update-ready' : 'throttled',
          changedUrls: this._changedUrls.slice(),
        };
      }
      this._lastCheckAt = now;

      if (!this._updateReady) {
        this._phase = 'checking';
        this._emitState();
      }

      if (typeof this._reg.update === 'function') {
        try {
          await this._reg.update();
        } catch (_) {}
      }

      const sw = this._nav && this._nav.serviceWorker;
      const target = (sw && sw.controller) || (this._reg && this._reg.active) || null;
      if (!target || typeof target.postMessage !== 'function') {
        if (!this._updateReady) {
          this._phase = 'idle';
          this._emitState();
        }
        return { status: 'failed', changedUrls: [] };
      }

      const reply = await this._sendCheckMessage(target, 15000);
      if (this._destroyed) {
        return { status: 'destroyed', changedUrls: [] };
      }

      if (reply && reply.type === 'K4_SW_UPDATE_READY') {
        this._handleUpdateReady(reply);
        return {
          status: 'update-ready',
          changedUrls: (reply.changedUrls || this._changedUrls).slice(),
        };
      }

      if (reply && reply.type === 'K4_SW_UP_TO_DATE') {
        if (!this._updateReady) {
          this._phase = 'idle';
          this._emitState();
        }
        return { status: 'up-to-date', changedUrls: [] };
      }

      if (!this._updateReady) {
        this._phase = 'idle';
        this._emitState();
      }
      const failResult = {
        status: 'failed',
        changedUrls: [],
        error: reply && reply.error ? reply.error : 'Update check failed',
      };
      if (reply && typeof reply.authRequired === 'boolean') {
        failResult.authRequired = reply.authRequired;
      }
      return failResult;
    }

    _sendCheckMessage(target, timeoutMs) {
      return new Promise((resolve) => {
        if (!this._MessageChannel) {
          resolve({ type: 'K4_SW_CHECK_FAILED', error: 'MessageChannel unavailable' });
          return;
        }
        let settled = false;
        let timer = null;
        const mc = new this._MessageChannel();
        const finish = (payload) => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          if (mc.port1) mc.port1.onmessage = null;
          resolve(payload);
        };
        timer = setTimeout(() => {
          finish({ type: 'K4_SW_CHECK_FAILED', error: 'Update check timed out' });
        }, timeoutMs);
        mc.port1.onmessage = (ev) => {
          finish(ev && ev.data ? ev.data : { type: 'K4_SW_CHECK_FAILED' });
        };
        try {
          target.postMessage({ type: 'K4_SW_CHECK_UPDATE' }, [mc.port2]);
        } catch (err) {
          finish({
            type: 'K4_SW_CHECK_FAILED',
            error: err && err.message ? err.message : String(err || 'postMessage failed'),
          });
        }
      });
    }

    _handleUpdateReady(info) {
      if (this._destroyed) return;
      this._updateReady = true;
      this._updateInfo = info || { reason: 'assets-changed', changedUrls: [] };
      if (Array.isArray(this._updateInfo.changedUrls) && this._updateInfo.changedUrls.length > 0) {
        this._changedUrls = Array.from(new Set(this._changedUrls.concat(this._updateInfo.changedUrls)));
      }
      this._reconcileUpdatePhase();
    }

    notifyActivityChanged() {
      if (!this._updateReady || this._destroyed || this._reloadingStarted) return;
      this._reconcileUpdatePhase();
    }

    _reconcileUpdatePhase() {
      if (!this._updateReady || this._destroyed || this._reloadingStarted) return;

      if (this._isTxBusy()) {
        this._clearCountdownTimer();
        this._clearReloadTimer();
        this._countdownSec = 0;
        if (this._phase !== 'deferred-tx') {
          this._phase = 'deferred-tx';
          this._emitState();
        }
        return;
      }

      if (this._isLoopGuarded()) {
        this._clearCountdownTimer();
        this._clearReloadTimer();
        this._countdownSec = 0;
        if (this._phase !== 'deferred-user') {
          this._phase = 'deferred-user';
          this._emitState();
        }
        return;
      }

      if (!this._isConnected()) {
        this._clearCountdownTimer();
        this._countdownSec = 0;
        this._phase = 'reloading';
        this._emitState();
        if (this._reloadTimer === null) {
          this._notify('Updating to latest version...', 'info');
          this._reloadTimer = setTimeout(() => {
            this._reloadTimer = null;
            if (!this._destroyed && !this._isTxBusy()) {
              this._performReload(false);
            } else {
              this._reconcileUpdatePhase();
            }
          }, Math.max(0, this._disconnectedReloadDelayMs));
        }
        return;
      }

      // Connected & RX idle
      this._clearReloadTimer();
      if (this._userDeferred) {
        this._clearCountdownTimer();
        this._countdownSec = 0;
        if (this._phase !== 'deferred-user') {
          this._phase = 'deferred-user';
          this._emitState();
        }
        return;
      }

      if (this._phase === 'countdown' && this._countdownTimer !== null) {
        return;
      }

      this._phase = 'countdown';
      this._countdownSec = Math.max(0, Math.round(this._connectedCountdownSec));
      this._emitState();

      if (this._countdownSec === 0) {
        this._performReload(false);
        return;
      }

      this._countdownTimer = setInterval(() => {
        if (this._destroyed || !this._updateReady || this._reloadingStarted) {
          this._clearCountdownTimer();
          return;
        }
        if (this._isTxBusy() || !this._isConnected() || this._userDeferred) {
          this._reconcileUpdatePhase();
          return;
        }
        this._countdownSec = Math.max(0, this._countdownSec - 1);
        if (this._countdownSec <= 0) {
          this._clearCountdownTimer();
          this._performReload(false);
        } else {
          this._emitState();
        }
      }, 1000);
    }

    _performReload(manual = false) {
      if (this._destroyed || this._reloadingStarted) return;
      this._reloadingStarted = true;
      this._clearTimers();
      this._phase = 'reloading';
      this._countdownSec = 0;
      this._emitState();

      if (!manual) {
        sessSet(this._sess, LAST_AUTO_RELOAD_KEY, String(this._nowFn()));
      }
      sessSet(this._sess, JUST_UPDATED_KEY, '1');

      if (this._onBeforeReload) {
        try {
          this._onBeforeReload({ manual: Boolean(manual), changedUrls: this._changedUrls.slice() });
        } catch (_) {}
      }
      this._reloadFn();
    }

    applyUpdateNow() {
      if (this._destroyed) return false;
      if (this._isTxBusy()) {
        this._notify('Finish transmitting before updating', 'warn');
        this._reconcileUpdatePhase();
        return false;
      }
      this._performReload(true);
      return true;
    }

    deferUpdate() {
      if (this._destroyed) return;
      this._clearCountdownTimer();
      this._clearReloadTimer();
      this._userDeferred = true;
      this._countdownSec = 0;
      if (this._updateReady) {
        this._phase = 'deferred-user';
      }
      this._emitState();
    }

    async promptInstall() {
      const ev = this._deferredPrompt;
      if (!ev || typeof ev.prompt !== 'function') {
        return { outcome: 'unavailable' };
      }
      this._deferredPrompt = null;
      this._emitState();
      try {
        await ev.prompt();
        const choice = ev.userChoice ? await ev.userChoice : { outcome: 'accepted' };
        this._emitState();
        return choice || { outcome: 'dismissed' };
      } catch (_) {
        this._emitState();
        return { outcome: 'dismissed' };
      }
    }

    setAudioPlaying(isPlaying) {
      this._audioPlaying = Boolean(isPlaying);
      this._reconcileWakeLock();
    }

    _shouldHoldWakeLock() {
      return Boolean(
        this._audioPlaying &&
          !this._destroyed &&
          PwaManager.isStandalone(this._win, this._nav) &&
          (!this._doc || this._doc.visibilityState !== 'hidden')
      );
    }

    _reconcileWakeLock() {
      if (this._shouldHoldWakeLock()) {
        void this._acquireWakeLock();
      } else {
        void this._releaseWakeLock();
      }
    }

    async _acquireWakeLock() {
      if (!this._shouldHoldWakeLock() || this._wakeLockSentinel || this._wakeLockRequesting) {
        return;
      }
      const wl = this._nav && this._nav.wakeLock;
      if (!wl || typeof wl.request !== 'function') {
        return;
      }
      this._wakeLockRequesting = true;
      try {
        const sentinel = await wl.request('screen');
        if (!sentinel) return;
        if (!this._shouldHoldWakeLock() || this._destroyed) {
          if (typeof sentinel.release === 'function') {
            Promise.resolve(sentinel.release()).catch(() => {});
          }
          return;
        }
        this._wakeLockSentinel = sentinel;
        if (typeof sentinel.addEventListener === 'function') {
          const onRel = () => {
            if (this._wakeLockReleaseCleanup) {
              this._wakeLockReleaseCleanup();
              this._wakeLockReleaseCleanup = null;
            }
            if (this._wakeLockSentinel === sentinel) {
              this._wakeLockSentinel = null;
              this._emitState();
            }
          };
          sentinel.addEventListener('release', onRel);
          this._wakeLockReleaseCleanup = () => {
            if (typeof sentinel.removeEventListener === 'function') {
              try {
                sentinel.removeEventListener('release', onRel);
              } catch (_) {}
            }
          };
        }
      } catch (_) {
        // Silently ignore wake lock rejections (e.g., low battery, permissions, backgrounded).
      } finally {
        this._wakeLockRequesting = false;
        this._emitState();
      }
    }

    _releaseWakeLock() {
      const sentinel = this._wakeLockSentinel;
      if (!sentinel) return Promise.resolve();
      this._wakeLockSentinel = null;
      if (this._wakeLockReleaseCleanup) {
        try {
          this._wakeLockReleaseCleanup();
        } catch (_) {}
        this._wakeLockReleaseCleanup = null;
      }
      let releasePromise = Promise.resolve();
      if (typeof sentinel.release === 'function') {
        try {
          releasePromise = Promise.resolve(sentinel.release()).catch(() => {});
        } catch (_) {
          releasePromise = Promise.resolve();
        }
      }
      this._emitState();
      return releasePromise;
    }

    getStatus() {
      return {
        supported: this._supported,
        isStandalone: PwaManager.isStandalone(this._win, this._nav),
        canInstall: Boolean(this._deferredPrompt),
        swRegistered: this._swRegistered,
        swActive: this._swActive,
        phase: this._phase,
        countdownSec: this._countdownSec,
        updateReady: this._updateReady,
        changedUrls: this._changedUrls.slice(),
        justUpdated: this._justUpdated,
        wakeLockActive: Boolean(this._wakeLockSentinel),
      };
    }

    destroy() {
      this._destroyed = true;
      this._clearTimers();
      void this._releaseWakeLock();
      for (let i = 0; i < this._cleanups.length; i++) {
        try {
          this._cleanups[i]();
        } catch (_) {}
      }
      this._cleanups = [];
    }
  }

  K4.PwaManager = PwaManager;
})();
