/**
 * MasterErrorHandler - Comprehensive error handling system
 * Provides formatted error messages with helpful suggestions and documentation links
 * Version: 1.0.0
 */

const path = require('path');

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
};

// Error code definitions
const ERROR_CODES = {
  MC_ERR_EVENT_HANDLER_NOT_FOUND: {
    title: 'Event Handler Not Found',
    docsPath: '/docs/events#handler-not-found',
    severity: 'error'
  },
  MC_ERR_EVENT_SYNTAX_INVALID: {
    title: 'Invalid @event Syntax',
    docsPath: '/docs/events#syntax',
    severity: 'error'
  },
  MC_ERR_COMPONENT_RENDER_FAILED: {
    title: 'Component Render Failed',
    docsPath: '/docs/ssr#render-errors',
    severity: 'error'
  },
  MC_ERR_TEMPRENDER_MISSING: {
    title: 'Missing tempRender() Method',
    docsPath: '/docs/components#temprender',
    severity: 'warning'
  },
  MC_ERR_DUPLICATE_ELEMENT: {
    title: 'Duplicate Custom Element Registration',
    docsPath: '/docs/components#duplicate-names',
    severity: 'warning'
  },
  MC_ERR_HYDRATION_MISMATCH: {
    title: 'Hydration Mismatch Detected',
    docsPath: '/docs/hydration#mismatches',
    severity: 'warning'
  },
  MC_ERR_SLOW_RENDER: {
    title: 'Slow Component Render',
    docsPath: '/docs/performance',
    severity: 'warning'
  },
  MC_ERR_MANIFEST_PARSE: {
    title: 'Event Manifest Parse Error',
    docsPath: '/docs/events#manifest-errors',
    severity: 'error'
  },
  MC_ERR_MODULE_LOAD: {
    title: 'Module Load Failed',
    docsPath: '/docs/troubleshooting#module-errors',
    severity: 'error'
  }
};

/**
 * Levenshtein distance for "Did you mean?" suggestions
 */
function levenshteinDistance(str1, str2) {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(0));

  for (let i = 0; i <= len1; i++) matrix[i][0] = i;
  for (let j = 0; j <= len2; j++) matrix[0][j] = j;

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[len1][len2];
}

/**
 * Find similar strings for suggestions
 */
function findSimilarStrings(target, candidates, maxSuggestions = 3) {
  if (!target || !candidates || candidates.length === 0) return [];

  const withDistances = candidates
    .map(candidate => ({
      value: candidate,
      distance: levenshteinDistance(target.toLowerCase(), candidate.toLowerCase())
    }))
    .filter(item => item.distance <= 3) // Only suggest if reasonably close
    .sort((a, b) => a.distance - b.distance);

  return withDistances.slice(0, maxSuggestions).map(item => item.value);
}

/**
 * Extract line number from stack trace
 */
function extractLineNumber(stack, filePath) {
  if (!stack || !filePath) return null;

  const lines = stack.split('\n');
  for (const line of lines) {
    if (line.includes(filePath)) {
      const match = line.match(/:(\d+):(\d+)/);
      if (match) return parseInt(match[1], 10);
    }
  }
  return null;
}

/**
 * Get relative path from project root
 */
function getRelativePath(absolutePath) {
  if (!absolutePath) return null;
  const cwd = process.cwd();
  return path.relative(cwd, absolutePath);
}

class MasterControllerError extends Error {
  constructor(options = {}) {
    super(options.message || 'An error occurred');

    this.name = 'MasterControllerError';
    this.code = options.code || 'MC_ERR_UNKNOWN';
    this.component = options.component || null;
    this.file = options.file || null;
    this.line = options.line || null;
    this.handler = options.handler || null;
    this.expected = options.expected || null;
    this.suggestions = options.suggestions || [];
    this.details = options.details || null;
    this.context = options.context || {};
    this.originalError = options.originalError || null;

    // Get error metadata from code
    this.metadata = ERROR_CODES[this.code] || {
      title: 'Unknown Error',
      docsPath: '/docs',
      severity: 'error'
    };

    // Build docs URL
    this.docsUrl = options.docsUrl || this._buildDocsUrl();

    // Extract line number from stack if not provided
    if (!this.line && this.originalError && this.originalError.stack && this.file) {
      this.line = extractLineNumber(this.originalError.stack, this.file);
    }

    Error.captureStackTrace(this, this.constructor);
  }

  _buildDocsUrl() {
    const baseUrl = process.env.MASTER_DOCS_URL || 'https://mastercontroller.dev';
    return baseUrl + this.metadata.docsPath;
  }

  /**
   * Format error for terminal output with colors
   */
  format() {
    const { bright, red, yellow, cyan, blue, green, dim, reset } = colors;
    const isError = this.metadata.severity === 'error';
    const icon = isError ? '❌' : '⚠️';
    const titleColor = isError ? red : yellow;

    let output = '\n';
    output += `${titleColor}${bright}${icon} MasterController ${isError ? 'Error' : 'Warning'}: ${this.metadata.title}${reset}\n`;
    output += `${dim}${'─'.repeat(80)}${reset}\n\n`;

    // Component info
    if (this.component) {
      output += `${cyan}Component:${reset} <${this.component}>\n`;
    }

    // File location
    if (this.file) {
      const relativePath = getRelativePath(this.file);
      const location = this.line ? `${relativePath}:${this.line}` : relativePath;
      output += `${cyan}Location:${reset} ${location}\n`;
    }

    // Handler details
    if (this.handler) {
      output += `${cyan}Handler:${reset} ${this.handler}`;
      if (this.expected) {
        output += ` ${dim}(expected: ${this.expected})${reset}`;
      }
      output += '\n';
    }

    // Main message
    if (this.message) {
      output += `\n${this.message}\n`;
    }

    // Details
    if (this.details) {
      output += `\n${dim}${this.details}${reset}\n`;
    }

    // Suggestions
    if (this.suggestions && this.suggestions.length > 0) {
      output += `\n${green}${bright}Did you mean?${reset}\n`;
      this.suggestions.forEach(suggestion => {
        output += `  ${green}→${reset} ${suggestion}\n`;
      });
    }

    // Fix instructions
    if (this.file && this.line) {
      output += `\n${blue}${bright}Fix:${reset} Check ${getRelativePath(this.file)}:${this.line}\n`;
    }

    // Original error stack (in development)
    if (this.originalError && process.env.NODE_ENV !== 'production') {
      output += `\n${dim}Original Error:${reset}\n${dim}${this.originalError.stack}${reset}\n`;
    }

    // Documentation link
    output += `\n${blue}${bright}Learn more:${reset} ${this.docsUrl}\n`;
    output += `${dim}${'─'.repeat(80)}${reset}\n`;

    return output;
  }

  /**
   * Format error for HTML output (development error page)
   */
  toHTML() {
    const isError = this.metadata.severity === 'error';
    const bgColor = isError ? '#fee' : '#fffbeb';
    const borderColor = isError ? '#f87171' : '#fbbf24';
    const iconColor = isError ? '#dc2626' : '#f59e0b';

    const relativePath = this.file ? getRelativePath(this.file) : '';
    const location = this.line ? `${relativePath}:${this.line}` : relativePath;

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MasterController ${isError ? 'Error' : 'Warning'}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f9fafb;
      padding: 20px;
      color: #1f2937;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
      background: white;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      overflow: hidden;
    }
    .header {
      background: ${bgColor};
      border-left: 4px solid ${borderColor};
      padding: 24px;
    }
    .header h1 {
      font-size: 24px;
      font-weight: 700;
      color: ${iconColor};
      margin-bottom: 8px;
    }
    .header .subtitle {
      font-size: 18px;
      color: #374151;
      font-weight: 600;
    }
    .content {
      padding: 24px;
    }
    .section {
      margin-bottom: 24px;
    }
    .section-title {
      font-size: 14px;
      font-weight: 600;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }
    .section-content {
      font-size: 16px;
      color: #1f2937;
      line-height: 1.6;
    }
    .code {
      background: #f3f4f6;
      padding: 12px 16px;
      border-radius: 6px;
      font-family: 'Courier New', monospace;
      font-size: 14px;
      overflow-x: auto;
      border-left: 3px solid #3b82f6;
    }
    .suggestions {
      list-style: none;
    }
    .suggestions li {
      background: #ecfdf5;
      padding: 8px 12px;
      margin-bottom: 8px;
      border-radius: 4px;
      border-left: 3px solid #10b981;
    }
    .suggestions li:before {
      content: '→ ';
      color: #10b981;
      font-weight: bold;
    }
    .link {
      display: inline-block;
      background: #3b82f6;
      color: white;
      padding: 10px 20px;
      border-radius: 6px;
      text-decoration: none;
      font-weight: 600;
      margin-top: 16px;
    }
    .link:hover {
      background: #2563eb;
    }
    .stack {
      background: #1f2937;
      color: #f3f4f6;
      padding: 16px;
      border-radius: 6px;
      font-family: 'Courier New', monospace;
      font-size: 12px;
      overflow-x: auto;
      max-height: 300px;
      overflow-y: auto;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${isError ? '❌ Error' : '⚠️ Warning'}</h1>
      <div class="subtitle">${this.escapeHtml(this.metadata.title)}</div>
    </div>

    <div class="content">
      ${this.component ? `
      <div class="section">
        <div class="section-title">Component</div>
        <div class="section-content code">&lt;${this.escapeHtml(this.component)}&gt;</div>
      </div>
      ` : ''}

      ${this.file ? `
      <div class="section">
        <div class="section-title">Location</div>
        <div class="section-content code">${this.escapeHtml(location)}</div>
      </div>
      ` : ''}

      ${this.handler ? `
      <div class="section">
        <div class="section-title">Handler</div>
        <div class="section-content code">${this.escapeHtml(this.handler)}${this.expected ? ` <span style="color: #6b7280;">(expected: ${this.escapeHtml(this.expected)})</span>` : ''}</div>
      </div>
      ` : ''}

      ${this.message ? `
      <div class="section">
        <div class="section-title">Message</div>
        <div class="section-content">${this.escapeHtml(this.message)}</div>
      </div>
      ` : ''}

      ${this.details ? `
      <div class="section">
        <div class="section-title">Details</div>
        <div class="section-content">${this.escapeHtml(this.details)}</div>
      </div>
      ` : ''}

      ${this.suggestions && this.suggestions.length > 0 ? `
      <div class="section">
        <div class="section-title">Did you mean?</div>
        <ul class="suggestions">
          ${this.suggestions.map(s => `<li>${this.escapeHtml(s)}</li>`).join('')}
        </ul>
      </div>
      ` : ''}

      ${this.originalError && process.env.NODE_ENV !== 'production' ? `
      <div class="section">
        <div class="section-title">Stack Trace</div>
        <pre class="stack">${this.escapeHtml(this.originalError.stack || '')}</pre>
      </div>
      ` : ''}

      <div class="section">
        <a href="${this.docsUrl}" class="link" target="_blank">View Documentation →</a>
      </div>
    </div>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Format error for JSON logging
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      severity: this.metadata.severity,
      component: this.component,
      file: this.file ? getRelativePath(this.file) : null,
      line: this.line,
      handler: this.handler,
      expected: this.expected,
      suggestions: this.suggestions,
      details: this.details,
      context: this.context,
      docsUrl: this.docsUrl,
      timestamp: new Date().toISOString(),
      stack: this.stack,
      originalError: this.originalError ? {
        message: this.originalError.message,
        stack: this.originalError.stack
      } : null
    };
  }

  /**
   * Escape HTML for safe output
   */
  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

// Export utilities
module.exports = {
  MasterControllerError,
  ERROR_CODES,
  findSimilarStrings,
  levenshteinDistance,
  getRelativePath,
  extractLineNumber
};
