'use strict';

(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const KEY_PREFIX = 'k4:';
  const memLocal = new Map();
  const memSession = new Map();

  function safeStorage(kind) {
    try {
      const store = kind === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
      return store || null;
    } catch (_) {
      return null;
    }
  }

  function decodeValue(raw) {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return raw;
    }
  }

  function readFrom(kind, memMap, key, defaultVal) {
    const namespaced = KEY_PREFIX + String(key);
    const store = safeStorage(kind);
    if (store) {
      try {
        const raw = store.getItem(namespaced);
        if (raw !== null) {
          return decodeValue(raw);
        }
      } catch (_) {
        // Fall through to in-memory Map when browser storage is blocked on file:// or private mode.
      }
    }
    if (memMap.has(namespaced)) {
      return decodeValue(memMap.get(namespaced));
    }
    return defaultVal;
  }

  function writeTo(kind, memMap, key, val) {
    const namespaced = KEY_PREFIX + String(key);
    if (val === undefined) {
      removeFrom(kind, memMap, key);
      return;
    }
    let serialized;
    try {
      serialized = JSON.stringify(val);
    } catch (_) {
      serialized = String(val);
    }
    memMap.set(namespaced, serialized);
    const store = safeStorage(kind);
    if (store) {
      try {
        store.setItem(namespaced, serialized);
      } catch (_) {
        // Keep in-memory copy when storage quota or origin policy rejects writes.
      }
    }
  }

  function removeFrom(kind, memMap, key) {
    const namespaced = KEY_PREFIX + String(key);
    memMap.delete(namespaced);
    const store = safeStorage(kind);
    if (store) {
      try {
        store.removeItem(namespaced);
      } catch (_) {
        // Ignore blocked storage access.
      }
    }
  }

  /**
   * Resilient storage facade wrapping localStorage and sessionStorage with in-memory Map fallback.
   */
  K4.storage = {
    get(key, defaultVal = undefined) {
      return readFrom('local', memLocal, key, defaultVal);
    },
    set(key, val) {
      writeTo('local', memLocal, key, val);
    },
    remove(key) {
      removeFrom('local', memLocal, key);
    },
    getSession(key, defaultVal = undefined) {
      return readFrom('session', memSession, key, defaultVal);
    },
    setSession(key, val) {
      writeTo('session', memSession, key, val);
    },
    removeSession(key) {
      removeFrom('session', memSession, key);
    },
  };

  const DEFAULT_BOOKMARKS = Object.freeze([
    { id: 'bm-40m-ft8', label: '40m FT8', freqHz: 7074000, mode: 6, dataSubMode: 0, bwHz: 2700 },
    { id: 'bm-wwv-10', label: 'WWV 10 MHz', freqHz: 10000000, mode: 5, dataSubMode: 0, bwHz: 4000 },
    { id: 'bm-20m-cw', label: '20m CW DX', freqHz: 14025000, mode: 3, dataSubMode: 0, bwHz: 500 },
    { id: 'bm-20m-ft8', label: '20m FT8', freqHz: 14074000, mode: 6, dataSubMode: 0, bwHz: 2700 },
    { id: 'bm-20m-usb', label: '20m SSB Call', freqHz: 14300000, mode: 2, dataSubMode: 0, bwHz: 2400 },
    { id: 'bm-15m-ft8', label: '15m FT8', freqHz: 21074000, mode: 6, dataSubMode: 0, bwHz: 2700 },
  ]);

  const bookmarkListeners = new Set();

  function cloneBookmarks(items) {
    return items
      .map((b) => ({
        id: String(b.id || ''),
        label: String(b.label || 'Bookmark'),
        freqHz: Math.round(Number(b.freqHz) || 14074000),
        mode: Number.isFinite(Number(b.mode)) ? Number(b.mode) : 2,
        dataSubMode: Number.isFinite(Number(b.dataSubMode)) ? Number(b.dataSubMode) : 0,
        bwHz: Number.isFinite(Number(b.bwHz)) ? Number(b.bwHz) : 2400,
      }))
      .sort((a, b) => a.freqHz - b.freqHz);
  }

  function loadBookmarksRaw() {
    const stored = K4.storage.get('bookmarks', null);
    if (Array.isArray(stored)) {
      return cloneBookmarks(stored);
    }
    const seeded = cloneBookmarks(DEFAULT_BOOKMARKS);
    K4.storage.set('bookmarks', seeded);
    return seeded;
  }

  function emitBookmarks(list) {
    for (const fn of bookmarkListeners) {
      try {
        fn(list);
      } catch (_) {}
    }
  }

  /**
   * Persistent amateur-band memory & frequency bookmark store backed by K4.storage.
   */
  K4.BookmarkStore = {
    list() {
      return loadBookmarksRaw();
    },
    add(entry = {}) {
      const freqHz = Math.max(100000, Math.min(54000000, Math.round(Number(entry.freqHz) || 14074000)));
      const label =
        String(entry.label || '').trim() ||
        `${(freqHz / 1000000).toFixed(4)} MHz`;
      const id =
        String(entry.id || '').trim() ||
        `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const item = {
        id,
        label: label.slice(0, 40),
        freqHz,
        mode: Number.isFinite(Number(entry.mode)) ? Number(entry.mode) : 2,
        dataSubMode: Number.isFinite(Number(entry.dataSubMode)) ? Number(entry.dataSubMode) : 0,
        bwHz: Number.isFinite(Number(entry.bwHz)) ? Number(entry.bwHz) : 2400,
      };
      const items = loadBookmarksRaw().filter((b) => b.id !== id);
      items.push(item);
      const next = cloneBookmarks(items);
      K4.storage.set('bookmarks', next);
      emitBookmarks(next);
      return item;
    },
    remove(id) {
      const items = loadBookmarksRaw().filter((b) => b.id !== id);
      const next = cloneBookmarks(items);
      K4.storage.set('bookmarks', next);
      emitBookmarks(next);
      return next;
    },
    resetDefaults() {
      const next = cloneBookmarks(DEFAULT_BOOKMARKS);
      K4.storage.set('bookmarks', next);
      emitBookmarks(next);
      return next;
    },
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      bookmarkListeners.add(fn);
      return () => bookmarkListeners.delete(fn);
    },
  };
})();
