'use strict';

(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  /**
   * Lightweight synchronous event emitter shared across transport, state, audio, and UI modules.
   */
  class EventEmitter {
    constructor() {
      this._listeners = new Map();
    }

    /**
     * Register a listener for `event` and return an unsubscribe function.
     * @param {string} event
     * @param {Function} fn
     * @returns {Function}
     */
    on(event, fn) {
      if (typeof fn !== 'function') {
        throw new TypeError('EventEmitter listener must be a function');
      }
      let set = this._listeners.get(event);
      if (!set) {
        set = new Set();
        this._listeners.set(event, set);
      }
      set.add(fn);
      return () => this.off(event, fn);
    }

    /**
     * Remove a specific listener, or all listeners for `event` if `fn` is omitted.
     * @param {string} event
     * @param {Function} [fn]
     */
    off(event, fn) {
      const set = this._listeners.get(event);
      if (!set) return;
      if (fn === undefined) {
        this._listeners.delete(event);
        return;
      }
      if (!set.delete(fn)) {
        for (const entry of set) {
          if (entry && entry._originalFn === fn) {
            set.delete(entry);
          }
        }
      }
      if (set.size === 0) {
        this._listeners.delete(event);
      }
    }

    /**
     * Register a one-shot listener that automatically unsubscribes after its first invocation.
     * @param {string} event
     * @param {Function} fn
     * @returns {Function}
     */
    once(event, fn) {
      if (typeof fn !== 'function') {
        throw new TypeError('EventEmitter listener must be a function');
      }
      const wrapper = (...args) => {
        this.off(event, wrapper);
        fn.apply(this, args);
      };
      wrapper._originalFn = fn;
      return this.on(event, wrapper);
    }

    /**
     * Synchronously invoke all listeners registered for `event`.
     * @param {string} event
     * @param {...*} args
     * @returns {boolean}
     */
    emit(event, ...args) {
      const set = this._listeners.get(event);
      if (!set || set.size === 0) return false;
      const snapshot = Array.from(set);
      for (let i = 0; i < snapshot.length; i++) {
        snapshot[i].apply(this, args);
      }
      return true;
    }

    /**
     * Remove all listeners for a specific event or all events.
     * @param {string} [event]
     */
    removeAllListeners(event) {
      if (event === undefined) {
        this._listeners.clear();
      } else {
        this._listeners.delete(event);
      }
    }
  }

  K4.EventEmitter = EventEmitter;
})();
