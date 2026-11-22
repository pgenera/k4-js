'use strict';

const CACHE_PREFIX = 'k4-observatory-';
const CACHE_NAME = 'k4-observatory-v1';

const UPDATE_WATCH_ASSETS = [
  './index.html',
  './manifest.webmanifest',
  './css/tokens.css',
  './css/layout.css',
  './css/components.css',
  './js/util/events.js',
  './js/util/build-info.js',
  './js/util/storage.js',
  './js/util/pwa.js',
  './js/protocol/sha384.js',
  './js/protocol/framer.js',
  './js/protocol/cat-codec.js',
  './js/protocol/binary-packets.js',
  './js/transport/rx-only-gate.js',
  './js/state/radio-state.js',
  './js/demo/ddc-demod.js',
  './js/demo/demo-socket.js',
  './js/transport/k4-client.js',
  './js/panadapter/band-plan.js',
  './js/panadapter/color-luts.js',
  './js/panadapter/dsp.js',
  './js/panadapter/webgl-renderer.js',
  './js/panadapter/interaction.js',
  './js/panadapter/panadapter-view.js',
  './js/audio/pcm-decoder.js',
  './js/audio/opus-decoder.js',
  './js/audio/worklet-source.js',
  './js/audio/audio-engine.js',
  './js/ui/vfo-widget.js',
  './js/ui/smeter-widget.js',
  './js/ui/omnibar.js',
  './js/ui/inspector-panels.js',
  './js/ui/connection-dialog.js',
  './js/ui/settings-panel.js',
  './js/app.js',
];

const ICON_ASSETS = [
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

const APP_SHELL_ASSETS = ['./', ...UPDATE_WATCH_ASSETS, ...ICON_ASSETS];

let activeCheckPromise = null;

function scopeUrl(relPath) {
  return new URL(relPath, self.registration.scope).href;
}

async function fetchWithTimeout(urlOrReq, init, timeoutMs = 4500) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  if (controller && timeoutMs > 0) {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch (_) {}
    }, timeoutMs);
  }
  const fetchInit = Object.assign({}, init || {});
  if (controller) {
    fetchInit.signal = controller.signal;
  }
  try {
    return await fetch(urlOrReq, fetchInit);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function bytesEqual(a, b) {
  const viewA = new Uint8Array(a);
  const viewB = new Uint8Array(b);
  if (viewA.byteLength !== viewB.byteLength) return false;
  for (let i = 0; i < viewA.byteLength; i++) {
    if (viewA[i] !== viewB[i]) return false;
  }
  return true;
}

async function responsesDiffer(cachedResp, freshResp) {
  if (!cachedResp || !freshResp) return true;
  const cachedEtag = (cachedResp.headers.get('etag') || '').trim();
  const freshEtag = (freshResp.headers.get('etag') || '').trim();
  if (cachedEtag && freshEtag) {
    if (cachedEtag === freshEtag) return false;
  } else if (!cachedEtag && !freshEtag) {
    const cachedLm = (cachedResp.headers.get('last-modified') || '').trim();
    const freshLm = (freshResp.headers.get('last-modified') || '').trim();
    const cachedLen = (cachedResp.headers.get('content-length') || '').trim();
    const freshLen = (freshResp.headers.get('content-length') || '').trim();
    if (cachedLm && freshLm && cachedLm === freshLm && cachedLen && freshLen && cachedLen === freshLen) {
      return false;
    }
  }
  const [bufA, bufB] = await Promise.all([
    cachedResp.clone().arrayBuffer(),
    freshResp.clone().arrayBuffer(),
  ]);
  return !bytesEqual(bufA, bufB);
}

function extractLocalAssetUrls(htmlText, baseUrl) {
  const urls = new Set();
  const baseOrigin = new URL(baseUrl).origin;
  const attrRegex = /(?:href|src)\s*=\s*["']([^"']+\.(?:css|js)(?:\?[^"']*)?)["']/gi;
  let match = null;
  while ((match = attrRegex.exec(htmlText)) !== null) {
    const rawRef = match[1];
    if (!rawRef) continue;
    try {
      const resolved = new URL(rawRef, baseUrl);
      if (resolved.origin === baseOrigin && !resolved.pathname.endsWith('/test.html')) {
        urls.add(resolved.href);
      }
    } catch (_) {}
  }
  return Array.from(urls);
}

async function mapWithConcurrency(items, limit, workerFn) {
  const results = new Array(items.length);
  let nextIdx = 0;
  let aborted = false;
  async function runner() {
    while (!aborted && nextIdx < items.length) {
      const idx = nextIdx++;
      try {
        results[idx] = await workerFn(items[idx], idx);
      } catch (err) {
        aborted = true;
        throw err;
      }
    }
  }
  const workers = [];
  const count = Math.min(Math.max(1, limit), items.length);
  for (let i = 0; i < count; i++) {
    workers.push(runner());
  }
  await Promise.all(workers);
  return results;
}

function isSafeSameOriginAssetResponse(resp, expectedPath) {
  if (!resp || !resp.ok || resp.redirected || resp.type === 'opaqueredirect' || resp.type === 'opaque') {
    return false;
  }
  try {
    if (!resp.url) return false;
    const parsed = new URL(resp.url);
    if (parsed.origin !== self.location.origin) return false;
  } catch (_) {
    return false;
  }
  const cleanPath = String(expectedPath || '').split(/[?#]/)[0].trim().toLowerCase();
  if (/\.(?:js|css|webmanifest|json|svg|png)$/.test(cleanPath)) {
    const ct = (
      resp.headers && typeof resp.headers.get === 'function' ? resp.headers.get('content-type') || '' : ''
    ).toLowerCase();
    if (ct.includes('text/html')) {
      return false;
    }
  }
  return true;
}

function isAuthBlockedResponse(resp) {
  return Boolean(
    resp &&
      (resp.type === 'opaqueredirect' ||
        resp.status === 401 ||
        resp.status === 403 ||
        (resp.status >= 300 && resp.status < 400))
  );
}

function buildCheckFailedError(resp, relPath) {
  const authRequired = isAuthBlockedResponse(resp);
  let msg;
  if (!resp) {
    msg = `Network error for ${relPath}`;
  } else if (resp.type === 'opaqueredirect') {
    msg = `Redirect blocked (auth required) for ${relPath}`;
  } else if (!resp.ok) {
    msg = `HTTP ${resp.status} for ${relPath}`;
  } else {
    const ct =
      (resp.headers && typeof resp.headers.get === 'function' ? resp.headers.get('content-type') : '') || 'unknown';
    msg = `Unsafe asset response (${resp.type}, ${ct}) for ${relPath}`;
  }
  const err = new Error(msg);
  err.authRequired = authRequired;
  return err;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await mapWithConcurrency(APP_SHELL_ASSETS, 6, async (relPath) => {
        const resolvedUrl = scopeUrl(relPath);
        try {
          const resp = await fetchWithTimeout(resolvedUrl, { cache: 'no-cache', redirect: 'manual' }, 8000);
          if (isSafeSameOriginAssetResponse(resp, relPath)) {
            await cache.put(resolvedUrl, resp.clone());
          }
        } catch (_) {
          // Allow partial precache resilience so first install does not block offline shell setup.
        }
      });
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

function isNavigationToShell(url) {
  const rootUrl = new URL('./', self.registration.scope);
  const indexUrl = new URL('./index.html', self.registration.scope);
  return url.pathname === rootUrl.pathname || url.pathname === indexUrl.pathname;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!req || req.method !== 'GET') return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  if ((req.headers.get('upgrade') || '').toLowerCase() === 'websocket') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  const scopePath = new URL('./', self.registration.scope).pathname;
  if (!url.pathname.startsWith(scopePath)) return;

  const relPath = url.pathname.slice(scopePath.length);
  if (
    relPath === 'ws' ||
    relPath.startsWith('ws/') ||
    url.pathname === '/ws' ||
    url.pathname.startsWith('/ws/') ||
    relPath === 'test.html' ||
    url.pathname.endsWith('/test.html')
  ) {
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        let lastResp = null;
        let fetchErr = null;
        try {
          const resp = await fetchWithTimeout(req, { cache: 'no-cache', redirect: 'manual' }, 4500);
          if (resp) {
            if (resp.type === 'opaqueredirect' || (resp.status >= 300 && resp.status < 400)) {
              return resp;
            }
            if (resp.status >= 400 && resp.status < 500) {
              return resp;
            }
            if (isSafeSameOriginAssetResponse(resp, './index.html')) {
              if (isNavigationToShell(url)) {
                await Promise.all([
                  cache.put(scopeUrl('./'), resp.clone()),
                  cache.put(scopeUrl('./index.html'), resp.clone()),
                ]);
              }
              return resp;
            }
            lastResp = resp;
          }
        } catch (err) {
          fetchErr = err;
        }
        if (!lastResp || lastResp.status >= 500 || lastResp.type === 'error') {
          const fallback =
            (await cache.match(scopeUrl('./index.html'))) ||
            (await cache.match(scopeUrl('./')));
          if (fallback) return fallback;
        }
        if (lastResp) return lastResp;
        if (typeof Response !== 'undefined' && typeof Response.error === 'function') {
          return Response.error();
        }
        throw fetchErr || new Error('Network error');
      })()
    );
    return;
  }

  const canonicalKey = url.search === '' ? url.origin + url.pathname : req.url;

  if (url.pathname.includes('/icons/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(canonicalKey);
        let lastResp = null;
        let fetchErr = null;
        const revalidate = (async () => {
          try {
            const resp = await fetchWithTimeout(canonicalKey, { cache: 'no-cache', redirect: 'manual' }, 4500);
            if (isSafeSameOriginAssetResponse(resp, relPath)) {
              await cache.put(canonicalKey, resp.clone());
              return resp;
            }
            lastResp = resp || null;
          } catch (err) {
            fetchErr = err;
          }
          return null;
        })();
        if (cached) {
          event.waitUntil(revalidate);
          return cached;
        }
        const net = await revalidate;
        if (net) return net;
        if (lastResp) {
          if (lastResp.type === 'opaqueredirect' || (lastResp.status >= 300 && lastResp.status < 600)) {
            return lastResp;
          }
          if (typeof Response !== 'undefined' && typeof Response.error === 'function') {
            return Response.error();
          }
          return lastResp;
        }
        if (typeof Response !== 'undefined' && typeof Response.error === 'function') {
          return Response.error();
        }
        throw fetchErr || new Error('Network error');
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      let lastResp = null;
      let fetchErr = null;
      try {
        const resp = await fetchWithTimeout(req, { cache: 'no-cache', redirect: 'manual' }, 4500);
        if (isSafeSameOriginAssetResponse(resp, relPath)) {
          await cache.put(canonicalKey, resp.clone());
          return resp;
        }
        lastResp = resp || null;
      } catch (err) {
        fetchErr = err;
      }
      if (lastResp) {
        if (lastResp.type === 'opaqueredirect' || (lastResp.status >= 300 && lastResp.status < 400)) {
          const cached = await cache.match(canonicalKey);
          if (cached) return cached;
          return lastResp;
        }
        if (lastResp.status >= 400 && lastResp.status < 500) {
          return lastResp;
        }
        const cached = await cache.match(canonicalKey);
        if (cached) return cached;
        if (lastResp.status >= 500) {
          return lastResp;
        }
        if (typeof Response !== 'undefined' && typeof Response.error === 'function') {
          return Response.error();
        }
        return lastResp;
      }
      const cached = await cache.match(canonicalKey);
      if (cached) return cached;
      if (typeof Response !== 'undefined' && typeof Response.error === 'function') {
        return Response.error();
      }
      throw fetchErr || new Error('Network error');
    })()
  );
});

async function runBackgroundUpdateCheck() {
  try {
    const cache = await caches.open(CACHE_NAME);

    const fetched = await mapWithConcurrency(UPDATE_WATCH_ASSETS, 4, async (relPath) => {
      const url = scopeUrl(relPath);
      const resp = await fetchWithTimeout(url, { cache: 'no-cache', redirect: 'manual' }, 8000);
      if (!isSafeSameOriginAssetResponse(resp, relPath)) {
        throw buildCheckFailedError(resp, relPath);
      }
      return { relPath, url, resp };
    });

    const watchedUrls = new Set(fetched.map((item) => item.url));
    const stagedWrites = [];
    const changed = [];
    let indexEntry = null;

    for (let i = 0; i < fetched.length; i++) {
      const item = fetched[i];
      const cachedResp = await cache.match(item.url);
      stagedWrites.push(item);
      if (item.relPath === './index.html') {
        indexEntry = item;
      }
      if (!cachedResp) {
        // Seed missing cache entry without triggering a false update prompt unless another asset changed.
        continue;
      }
      const differs = await responsesDiffer(cachedResp, item.resp);
      if (differs) {
        changed.push(item);
      }
    }

    if (indexEntry && changed.some((c) => c.relPath === './index.html')) {
      const htmlText = await indexEntry.resp.clone().text();
      const discoveredUrls = extractLocalAssetUrls(htmlText, scopeUrl('./'));
      const extraUrls = discoveredUrls.filter((u) => !watchedUrls.has(u));
      if (extraUrls.length > 0) {
        const extraFetched = await mapWithConcurrency(extraUrls, 4, async (url) => {
          const resp = await fetchWithTimeout(url, { cache: 'no-cache', redirect: 'manual' }, 8000);
          if (!isSafeSameOriginAssetResponse(resp, url)) {
            throw buildCheckFailedError(resp, url);
          }
          return { relPath: url, url, resp };
        });
        for (let i = 0; i < extraFetched.length; i++) {
          stagedWrites.push(extraFetched[i]);
        }
      }
    }

    // Commit staged writes atomically after all fetches succeed.
    for (let i = 0; i < stagedWrites.length; i++) {
      const entry = stagedWrites[i];
      await cache.put(entry.url, entry.resp.clone());
      if (entry.relPath === './index.html') {
        await cache.put(scopeUrl('./'), entry.resp.clone());
      }
    }

    if (changed.length > 0) {
      const payload = {
        type: 'K4_SW_UPDATE_READY',
        reason: 'assets-changed',
        changedUrls: changed.map((c) => c.relPath),
        timestamp: Date.now(),
      };
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
      for (let i = 0; i < clients.length; i++) {
        clients[i].postMessage(payload);
      }
      return payload;
    }

    return {
      type: 'K4_SW_UP_TO_DATE',
      checked: UPDATE_WATCH_ASSETS.length,
      timestamp: Date.now(),
    };
  } catch (err) {
    return {
      type: 'K4_SW_CHECK_FAILED',
      authRequired: Boolean(err && err.authRequired),
      error: err && err.message ? err.message : String(err || 'Update check failed'),
    };
  }
}

function getOrStartUpdateCheck() {
  if (!activeCheckPromise) {
    activeCheckPromise = runBackgroundUpdateCheck().finally(() => {
      activeCheckPromise = null;
    });
  }
  return activeCheckPromise;
}

self.addEventListener('message', (event) => {
  const data = event && event.data;
  if (!data || typeof data !== 'object') return;
  const replyPort = event.ports && event.ports[0] ? event.ports[0] : null;

  if (data.type === 'K4_SW_SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
    return;
  }

  if (data.type === 'K4_SW_CHECK_UPDATE') {
    event.waitUntil(
      (async () => {
        try {
          const result = await getOrStartUpdateCheck();
          if (replyPort) replyPort.postMessage(result);
        } catch (err) {
          if (replyPort) {
            replyPort.postMessage({
              type: 'K4_SW_CHECK_FAILED',
              authRequired: Boolean(err && err.authRequired),
              error: err && err.message ? err.message : String(err || 'Update check failed'),
            });
          }
        }
      })()
    );
  }
});
