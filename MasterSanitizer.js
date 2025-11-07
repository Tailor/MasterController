// version 1.0.0
// MasterController HTML Sanitizer - XSS Protection

/**
 * Comprehensive HTML sanitization to prevent XSS attacks
 * Protects against: script injection, event handler injection, data URI attacks,
 * CSS injection, iframe attacks, form hijacking, meta tag injection
 */

const { logger } = require('./MasterErrorLogger');

// Dangerous HTML tags that should be removed
const DANGEROUS_TAGS = [
  'script', 'iframe', 'object', 'embed', 'applet',
  'link', 'style', 'meta', 'base', 'form',
  'input', 'button', 'textarea', 'select', 'option',
  'frame', 'frameset', 'layer', 'ilayer',
  'bgsound', 'xml', 'plaintext', 'xmp'
];

// Dangerous attributes that can execute code
const DANGEROUS_ATTRIBUTES = [
  'onload', 'onerror', 'onclick', 'onmouseover', 'onmouseout',
  'onmousemove', 'onmousedown', 'onmouseup', 'onkeydown', 'onkeyup',
  'onkeypress', 'onfocus', 'onblur', 'onchange', 'onsubmit',
  'onreset', 'onselect', 'onabort', 'ondrag', 'ondrop',
  'ondragstart', 'ondragend', 'ondragover', 'ondragleave',
  'ondragenter', 'onwheel', 'onscroll', 'ontouchstart',
  'ontouchend', 'ontouchmove', 'onanimationstart', 'onanimationend',
  'ontransitionend', 'formaction', 'action', 'poster'
];

// Dangerous URL protocols
const DANGEROUS_PROTOCOLS = [
  'javascript:', 'data:', 'vbscript:', 'file:', 'about:',
  'ms-its:', 'mhtml:', 'jar:', 'wyciwyg:'
];

// Allowed tags for user-generated content (whitelist approach)
const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'u', 'b', 'i', 'span', 'div',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code', 'hr',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'a', 'img', 'video', 'audio', 'source'
];

// Allowed attributes for each tag
const ALLOWED_ATTRIBUTES = {
  'a': ['href', 'title', 'rel', 'target'],
  'img': ['src', 'alt', 'title', 'width', 'height'],
  'video': ['src', 'controls', 'width', 'height', 'poster'],
  'audio': ['src', 'controls'],
  'source': ['src', 'type'],
  'div': ['class', 'id'],
  'span': ['class', 'id'],
  'p': ['class', 'id'],
  'table': ['class', 'id'],
  'td': ['colspan', 'rowspan'],
  'th': ['colspan', 'rowspan'],
  'h1': ['class', 'id'],
  'h2': ['class', 'id'],
  'h3': ['class', 'id'],
  'h4': ['class', 'id'],
  'h5': ['class', 'id'],
  'h6': ['class', 'id']
};

class MasterSanitizer {
  constructor(options = {}) {
    this.allowedTags = options.allowedTags || ALLOWED_TAGS;
    this.allowedAttributes = options.allowedAttributes || ALLOWED_ATTRIBUTES;
    this.stripDisallowed = options.stripDisallowed !== false;
    this.logViolations = options.logViolations !== false;
  }

  /**
   * Sanitize HTML string to prevent XSS attacks
   * @param {string} html - HTML string to sanitize
   * @param {object} options - Sanitization options
   * @returns {string} - Sanitized HTML
   */
  sanitizeHTML(html, options = {}) {
    if (!html || typeof html !== 'string') {
      return '';
    }

    try {
      let sanitized = html;

      // Remove dangerous tags
      sanitized = this._removeDangerousTags(sanitized);

      // Remove dangerous attributes
      sanitized = this._removeDangerousAttributes(sanitized);

      // Sanitize URLs in href/src attributes
      sanitized = this._sanitizeURLs(sanitized);

      // Remove comments (can hide XSS)
      sanitized = this._removeComments(sanitized);

      // Apply whitelist if strict mode
      if (options.strict) {
        sanitized = this._applyWhitelist(sanitized);
      }

      // Encode special characters
      if (options.encode) {
        sanitized = this.encodeHTML(sanitized);
      }

      return sanitized;
    } catch (error) {
      logger.error({
        code: 'MC_ERR_SANITIZATION',
        message: 'HTML sanitization failed',
        error: error.message
      });
      // Return empty string on error to be safe
      return '';
    }
  }

  /**
   * Remove dangerous HTML tags
   */
  _removeDangerousTags(html) {
    let sanitized = html;

    DANGEROUS_TAGS.forEach(tag => {
      // Remove opening and closing tags
      const regex = new RegExp(`<${tag}[^>]*>.*?<\/${tag}>`, 'gis');
      sanitized = sanitized.replace(regex, '');

      // Remove self-closing tags
      const selfClosing = new RegExp(`<${tag}[^>]*\/>`, 'gi');
      sanitized = sanitized.replace(selfClosing, '');

      // Remove unclosed tags
      const unclosed = new RegExp(`<${tag}[^>]*>`, 'gi');
      sanitized = sanitized.replace(unclosed, '');
    });

    // Log violation
    if (sanitized !== html && this.logViolations) {
      logger.warn({
        code: 'MC_WARN_XSS_ATTEMPT',
        message: 'Dangerous HTML tags removed',
        tags: DANGEROUS_TAGS.filter(tag => html.toLowerCase().includes(`<${tag}`))
      });
    }

    return sanitized;
  }

  /**
   * Remove dangerous attributes that can execute code
   */
  _removeDangerousAttributes(html) {
    let sanitized = html;

    DANGEROUS_ATTRIBUTES.forEach(attr => {
      // Remove attribute with any value
      const regex = new RegExp(`\\s${attr}\\s*=\\s*["'][^"']*["']`, 'gi');
      sanitized = sanitized.replace(regex, '');

      // Remove attribute without quotes
      const noQuotes = new RegExp(`\\s${attr}\\s*=\\s*[^\\s>]+`, 'gi');
      sanitized = sanitized.replace(noQuotes, '');
    });

    // Log violation
    if (sanitized !== html && this.logViolations) {
      logger.warn({
        code: 'MC_WARN_XSS_ATTEMPT',
        message: 'Dangerous HTML attributes removed',
        attributes: DANGEROUS_ATTRIBUTES.filter(attr =>
          new RegExp(`\\s${attr}\\s*=`, 'i').test(html)
        )
      });
    }

    return sanitized;
  }

  /**
   * Sanitize URLs to prevent javascript: and data: protocol attacks
   */
  _sanitizeURLs(html) {
    let sanitized = html;

    // Sanitize href attributes
    sanitized = sanitized.replace(/href\s*=\s*["']([^"']*)["']/gi, (match, url) => {
      const cleanUrl = this._cleanURL(url);
      return `href="${cleanUrl}"`;
    });

    // Sanitize src attributes
    sanitized = sanitized.replace(/src\s*=\s*["']([^"']*)["']/gi, (match, url) => {
      const cleanUrl = this._cleanURL(url);
      return `src="${cleanUrl}"`;
    });

    return sanitized;
  }

  /**
   * Clean individual URL
   */
  _cleanURL(url) {
    if (!url) return '';

    const trimmed = url.trim().toLowerCase();

    // Check for dangerous protocols
    for (const protocol of DANGEROUS_PROTOCOLS) {
      if (trimmed.startsWith(protocol)) {
        if (this.logViolations) {
          logger.warn({
            code: 'MC_WARN_XSS_ATTEMPT',
            message: 'Dangerous URL protocol blocked',
            url: url,
            protocol: protocol
          });
        }
        return '#';
      }
    }

    // Check for encoded javascript
    if (trimmed.includes('%6a%61%76%61%73%63%72%69%70%74') || // javascript
        trimmed.includes('&#')) { // HTML entities
      if (this.logViolations) {
        logger.warn({
          code: 'MC_WARN_XSS_ATTEMPT',
          message: 'Encoded malicious URL blocked',
          url: url
        });
      }
      return '#';
    }

    return url;
  }

  /**
   * Remove HTML comments (can hide XSS)
   */
  _removeComments(html) {
    return html.replace(/<!--[\s\S]*?-->/g, '');
  }

  /**
   * Apply whitelist - only allow specific tags and attributes
   */
  _applyWhitelist(html) {
    // This is a simple implementation - for production use a library like DOMPurify
    let sanitized = html;

    // Remove all tags not in whitelist
    const tagRegex = /<\/?([a-z][a-z0-9]*)\b[^>]*>/gi;
    sanitized = sanitized.replace(tagRegex, (match, tagName) => {
      const tag = tagName.toLowerCase();

      // Check if tag is allowed
      if (!this.allowedTags.includes(tag)) {
        if (this.logViolations) {
          logger.warn({
            code: 'MC_WARN_TAG_BLOCKED',
            message: `Tag not in whitelist: ${tag}`
          });
        }
        return '';
      }

      // Filter attributes
      const allowedAttrs = this.allowedAttributes[tag] || [];
      if (allowedAttrs.length === 0) {
        // Tag has no allowed attributes, return clean tag
        return match.startsWith('</') ? `</${tag}>` : `<${tag}>`;
      }

      // Keep only allowed attributes
      let cleanTag = match.replace(/\s+([a-z-]+)\s*=\s*["']([^"']*)["']/gi, (attrMatch, attrName, attrValue) => {
        if (allowedAttrs.includes(attrName.toLowerCase())) {
          return ` ${attrName}="${attrValue}"`;
        }
        return '';
      });

      return cleanTag;
    });

    return sanitized;
  }

  /**
   * Encode HTML special characters
   * Use this for displaying user input as text (not HTML)
   */
  encodeHTML(str) {
    if (!str || typeof str !== 'string') {
      return '';
    }

    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');
  }

  /**
   * Decode HTML entities
   */
  decodeHTML(str) {
    if (!str || typeof str !== 'string') {
      return '';
    }

    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, '/');
  }

  /**
   * Safe innerHTML replacement
   * Use this instead of element.innerHTML for user content
   */
  safeSetInnerHTML(element, html, options = {}) {
    if (!element) return;

    const sanitized = this.sanitizeHTML(html, options);
    element.innerHTML = sanitized;
  }

  /**
   * Sanitize component props/attributes
   */
  sanitizeProps(props) {
    if (!props || typeof props !== 'object') {
      return {};
    }

    const sanitized = {};

    for (const [key, value] of Object.entries(props)) {
      // Skip internal props
      if (key.startsWith('_') || key.startsWith('__')) {
        continue;
      }

      // Sanitize string values
      if (typeof value === 'string') {
        sanitized[key] = this.encodeHTML(value);
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitizeProps(value);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Sanitize text content (for text nodes, not HTML)
   */
  sanitizeText(text) {
    if (!text || typeof text !== 'string') {
      return '';
    }

    return this.encodeHTML(text);
  }
}

// Create singleton instance
const sanitizer = new MasterSanitizer();

/**
 * Quick sanitization functions for common use cases
 */

// Sanitize user-generated HTML (strict mode)
function sanitizeUserHTML(html) {
  return sanitizer.sanitizeHTML(html, { strict: true });
}

// Sanitize template HTML (less strict, but remove dangerous content)
function sanitizeTemplateHTML(html) {
  return sanitizer.sanitizeHTML(html, { strict: false });
}

// Encode text to display as-is (not as HTML)
function escapeHTML(text) {
  return sanitizer.encodeHTML(text);
}

// Safe prop sanitization
function sanitizeProps(props) {
  return sanitizer.sanitizeProps(props);
}

// Safe innerHTML setter
function safeInnerHTML(element, html) {
  return sanitizer.safeSetInnerHTML(element, html, { strict: true });
}

module.exports = {
  MasterSanitizer,
  sanitizer,
  sanitizeUserHTML,
  sanitizeTemplateHTML,
  escapeHTML,
  sanitizeProps,
  safeInnerHTML,
  DANGEROUS_TAGS,
  DANGEROUS_ATTRIBUTES,
  DANGEROUS_PROTOCOLS
};
