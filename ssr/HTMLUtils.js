/**
 * Deprecated: HTMLUtils.js
 * Enhance SSR now compiles native web components directly to HTML.
 * This file remains as a no-op compatibility stub so any legacy references do not break.
 */
class HTMLUtils {
  static escapeAttr(v) { return String(v ?? ''); }
  static unescapeAttr(v) { return v; }
  static encodeData(v) { return this.escapeAttr(v); }
  static decodeData(v) { return this.unescapeAttr(v); }
  static dataAttr(name, value) { return `${name}="${this.escapeAttr(value)}"`; }
}
if (typeof module !== 'undefined' && module.exports) module.exports = HTMLUtils;
if (typeof window !== 'undefined') window.HTMLUtils = HTMLUtils;
if (typeof exports !== 'undefined') exports.HTMLUtils = HTMLUtils;
