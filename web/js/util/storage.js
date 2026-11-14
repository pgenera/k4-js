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
})();
