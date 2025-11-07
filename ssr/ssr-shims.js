// SSR Shims for Browser-only APIs
// This module provides no-op implementations of browser APIs that don't exist in Node.js
// Used during server-side rendering to prevent errors when components reference browser APIs

if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}

if (typeof globalThis.document === 'undefined') {
  // LinkeDOM document gets assigned elsewhere (MasterWebComponent.js)
  // but we ensure a placeholder so code referencing window.document doesn't crash.
  globalThis.document = { createElement: () => ({}) };
}

// 🧭 ResizeObserver
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// 👀 IntersectionObserver
if (typeof globalThis.IntersectionObserver === 'undefined') {
  globalThis.IntersectionObserver = class {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// 🖥️ MatchMedia
if (typeof globalThis.matchMedia === 'undefined') {
  globalThis.matchMedia = () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {}
  });
}

// 🕒 requestAnimationFrame & cancelAnimationFrame
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
}
if (typeof globalThis.cancelAnimationFrame === 'undefined') {
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}

// 💡 getComputedStyle
if (typeof globalThis.getComputedStyle === 'undefined') {
  globalThis.getComputedStyle = () => ({
    getPropertyValue: () => ''
  });
}

// 🧍 window.navigator shim
if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = { userAgent: 'ssr' };
}

// 📜 Common window methods that should be no-ops during SSR
['scrollTo', 'scrollBy', 'alert', 'confirm', 'focus', 'blur'].forEach(fn => {
  if (typeof globalThis[fn] === 'undefined') {
    globalThis[fn] = () => {};
  }
});

export default {};
