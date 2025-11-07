// version 1.0.0
// MasterController Content Security Policy (CSP) Configuration

/**
 * Content Security Policy (CSP) configuration
 * Helps prevent XSS, clickjacking, and other code injection attacks
 */

const crypto = require('crypto');

/**
 * CSP Presets for different environments
 */

// Development CSP - more relaxed for hot reload, dev tools
const DEVELOPMENT_CSP = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'", "http://localhost:*", "ws://localhost:*"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'https:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'", 'http://localhost:*', 'ws://localhost:*'],
  'media-src': ["'self'"],
  'object-src': ["'none'"],
  'frame-src': ["'self'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'self'"]
};

// Production CSP - strict security
const PRODUCTION_CSP = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:', 'https:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'media-src': ["'self'"],
  'object-src': ["'none'"],
  'frame-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
  'upgrade-insecure-requests': []
};

// Production with CDN support
const PRODUCTION_CDN_CSP = {
  'default-src': ["'self'"],
  'script-src': ["'self'", 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
  'style-src': ["'self'", 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
  'img-src': ["'self'", 'data:', 'https:'],
  'font-src': ["'self'", 'https://cdn.jsdelivr.net', 'https://fonts.gstatic.com'],
  'connect-src': ["'self'", 'https://*.sentry.io'],
  'media-src': ["'self'"],
  'object-src': ["'none'"],
  'frame-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
  'upgrade-insecure-requests': []
};

class CSPConfig {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.reportOnly = options.reportOnly || false;
    this.reportUri = options.reportUri || null;
    this.useNonce = options.useNonce || false;
    this.useHash = options.useHash || false;

    // Start with preset based on environment
    const env = process.env.NODE_ENV || 'development';
    let preset;

    if (options.preset === 'production-cdn') {
      preset = PRODUCTION_CDN_CSP;
    } else if (env === 'production') {
      preset = PRODUCTION_CSP;
    } else {
      preset = DEVELOPMENT_CSP;
    }

    // Merge custom directives with preset
    this.directives = { ...preset, ...options.directives };

    // Nonce store (cleared per request)
    this.currentNonce = null;
  }

  /**
   * Generate CSP header middleware
   */
  middleware() {
    return (req, res, next) => {
      if (!this.enabled) {
        return next();
      }

      // Generate nonce for this request if needed
      if (this.useNonce) {
        this.currentNonce = this._generateNonce();
        req.cspNonce = this.currentNonce;
      }

      // Build CSP header
      const headerValue = this.buildHeader(req);

      // Set header
      const headerName = this.reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
      res.setHeader(headerName, headerValue);

      next();
    };
  }

  /**
   * Build CSP header value
   */
  buildHeader(req = null) {
    const directives = [];

    for (const [directive, values] of Object.entries(this.directives)) {
      if (!values || values.length === 0) {
        // Directive with no value (e.g., upgrade-insecure-requests)
        directives.push(directive);
        continue;
      }

      let sources = [...values];

      // Add nonce to script-src and style-src if enabled
      if (this.useNonce && this.currentNonce && (directive === 'script-src' || directive === 'style-src')) {
        sources.push(`'nonce-${this.currentNonce}'`);
      }

      directives.push(`${directive} ${sources.join(' ')}`);
    }

    // Add report-uri if configured
    if (this.reportUri) {
      directives.push(`report-uri ${this.reportUri}`);
    }

    return directives.join('; ');
  }

  /**
   * Generate nonce for inline scripts/styles
   */
  _generateNonce() {
    return crypto.randomBytes(16).toString('base64');
  }

  /**
   * Get current nonce (for use in templates)
   */
  getNonce() {
    return this.currentNonce;
  }

  /**
   * Add source to directive
   */
  addSource(directive, source) {
    if (!this.directives[directive]) {
      this.directives[directive] = [];
    }

    if (!this.directives[directive].includes(source)) {
      this.directives[directive].push(source);
    }
  }

  /**
   * Remove source from directive
   */
  removeSource(directive, source) {
    if (!this.directives[directive]) {
      return;
    }

    const index = this.directives[directive].indexOf(source);
    if (index > -1) {
      this.directives[directive].splice(index, 1);
    }
  }

  /**
   * Set entire directive
   */
  setDirective(directive, sources) {
    this.directives[directive] = Array.isArray(sources) ? sources : [sources];
  }

  /**
   * Remove directive
   */
  removeDirective(directive) {
    delete this.directives[directive];
  }

  /**
   * Generate hash for inline script/style
   * Use this to allow specific inline scripts without 'unsafe-inline'
   */
  generateHash(content, algorithm = 'sha256') {
    const hash = crypto.createHash(algorithm).update(content).digest('base64');
    return `'${algorithm}-${hash}'`;
  }

  /**
   * Helper to create nonce attribute for templates
   */
  nonceAttr() {
    return this.currentNonce ? ` nonce="${this.currentNonce}"` : '';
  }

  /**
   * Enable/disable specific features
   */
  allowInlineScripts() {
    this.addSource('script-src', "'unsafe-inline'");
  }

  allowInlineStyles() {
    this.addSource('style-src', "'unsafe-inline'");
  }

  allowEval() {
    this.addSource('script-src', "'unsafe-eval'");
  }

  allowFraming(sources = ["'self'"]) {
    this.setDirective('frame-ancestors', sources);
  }

  allowForms(sources = ["'self'"]) {
    this.setDirective('form-action', sources);
  }

  /**
   * Add monitoring/analytics services
   */
  allowGoogleAnalytics() {
    this.addSource('script-src', 'https://www.google-analytics.com');
    this.addSource('connect-src', 'https://www.google-analytics.com');
    this.addSource('img-src', 'https://www.google-analytics.com');
  }

  allowSentry() {
    this.addSource('script-src', 'https://browser.sentry-cdn.com');
    this.addSource('connect-src', 'https://*.sentry.io');
  }

  allowStripe() {
    this.addSource('script-src', 'https://js.stripe.com');
    this.addSource('frame-src', 'https://js.stripe.com');
    this.addSource('connect-src', 'https://api.stripe.com');
  }

  /**
   * Get CSP configuration for debugging
   */
  getConfig() {
    return {
      enabled: this.enabled,
      reportOnly: this.reportOnly,
      reportUri: this.reportUri,
      useNonce: this.useNonce,
      directives: this.directives
    };
  }
}

/**
 * Create CSP with common configurations
 */

function createDevelopmentCSP() {
  return new CSPConfig({
    preset: 'development',
    reportOnly: true
  });
}

function createProductionCSP(options = {}) {
  return new CSPConfig({
    preset: 'production',
    reportOnly: false,
    useNonce: true,
    ...options
  });
}

function createProductionCDNCSP(options = {}) {
  return new CSPConfig({
    preset: 'production-cdn',
    reportOnly: false,
    useNonce: true,
    ...options
  });
}

// Create singleton instance based on environment
const env = process.env.NODE_ENV || 'development';
const csp = env === 'production' ? createProductionCSP() : createDevelopmentCSP();

module.exports = {
  CSPConfig,
  csp,
  createDevelopmentCSP,
  createProductionCSP,
  createProductionCDNCSP,
  DEVELOPMENT_CSP,
  PRODUCTION_CSP,
  PRODUCTION_CDN_CSP
};
