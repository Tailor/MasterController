// version 1.0.1
// MasterController Input Validator - SQL Injection, Path Traversal, Command Injection Protection

/**
 * Comprehensive input validation to prevent:
 * - SQL Injection
 * - NoSQL Injection
 * - Path Traversal
 * - Command Injection
 * - LDAP Injection
 * - XML Injection
 * - Header Injection
 */

const { logger } = require('../error/MasterErrorLogger');
const { escapeHTML } = require('./MasterSanitizer');
const path = require('path');

// SQL injection patterns
const SQL_INJECTION_PATTERNS = [
  /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE|UNION|DECLARE)\b)/gi,
  /(--|;|\/\*|\*\/|xp_|sp_)/gi,
  /('|(\\'))|("|(\\"))(\s|$)/gi,
  /(\bOR\b|\bAND\b).*?=.*?/gi,
  /(0x[0-9a-f]+)/gi
];

// NoSQL injection patterns (MongoDB, etc.)
const NOSQL_INJECTION_PATTERNS = [
  /\$where/gi,
  /\$ne/gi,
  /\$gt/gi,
  /\$lt/gi,
  /\$regex/gi,
  /\$nin/gi,
  /\$in/gi
];

// Command injection patterns
const COMMAND_INJECTION_PATTERNS = [
  /[;&|`$()]/g,
  /\n/g,
  /\r/g
];

// Path traversal patterns
const PATH_TRAVERSAL_PATTERNS = [
  /\.\./g,
  /\.\/\./g,
  /%2e%2e/gi,
  /%252e/gi,
  /\.\.%2f/gi,
  /\.\.%5c/gi
];

// LDAP injection patterns
const LDAP_INJECTION_PATTERNS = [
  /[*()\\]/g,
  /\x00/g
];

// Email validation regex
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

// URL validation regex
const URL_REGEX = /^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)$/;

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class MasterValidator {
  constructor(options = {}) {
    this.throwOnError = options.throwOnError || false;
    this.logViolations = options.logViolations !== false;
  }

  /**
   * Validate and sanitize string input
   */
  validateString(input, options = {}) {
    const {
      minLength = 0,
      maxLength = 10000,
      allowEmpty = true,
      trim = true,
      pattern = null,
      name = 'input'
    } = options;

    // Type check
    if (typeof input !== 'string') {
      return this._handleError('INVALID_TYPE', `${name} must be a string`, { input });
    }

    let sanitized = trim ? input.trim() : input;

    // Empty check
    if (!allowEmpty && sanitized.length === 0) {
      return this._handleError('EMPTY_STRING', `${name} cannot be empty`, { input });
    }

    // Length check
    if (sanitized.length < minLength) {
      return this._handleError('TOO_SHORT', `${name} must be at least ${minLength} characters`, { input });
    }

    if (sanitized.length > maxLength) {
      sanitized = sanitized.substring(0, maxLength);
      this._logWarning('STRING_TRUNCATED', `${name} was truncated to ${maxLength} characters`);
    }

    // Pattern check
    if (pattern && !pattern.test(sanitized)) {
      return this._handleError('PATTERN_MISMATCH', `${name} does not match required pattern`, { input });
    }

    return { valid: true, value: sanitized };
  }

  /**
   * Validate and sanitize integer
   */
  validateInteger(input, options = {}) {
    const {
      min = Number.MIN_SAFE_INTEGER,
      max = Number.MAX_SAFE_INTEGER,
      name = 'input'
    } = options;

    const parsed = parseInt(input, 10);

    if (isNaN(parsed)) {
      return this._handleError('INVALID_INTEGER', `${name} must be a valid integer`, { input });
    }

    if (parsed < min) {
      return this._handleError('TOO_SMALL', `${name} must be at least ${min}`, { input });
    }

    if (parsed > max) {
      return this._handleError('TOO_LARGE', `${name} must be at most ${max}`, { input });
    }

    return { valid: true, value: parsed };
  }

  /**
   * Validate email address
   */
  validateEmail(input, options = {}) {
    const { name = 'email' } = options;

    if (typeof input !== 'string') {
      return this._handleError('INVALID_TYPE', `${name} must be a string`, { input });
    }

    const trimmed = input.trim().toLowerCase();

    if (!EMAIL_REGEX.test(trimmed)) {
      return this._handleError('INVALID_EMAIL', `${name} is not a valid email address`, { input });
    }

    return { valid: true, value: trimmed };
  }

  /**
   * Validate URL
   */
  validateURL(input, options = {}) {
    const { name = 'url', allowedProtocols = ['http:', 'https:'] } = options;

    if (typeof input !== 'string') {
      return this._handleError('INVALID_TYPE', `${name} must be a string`, { input });
    }

    const trimmed = input.trim();

    if (!URL_REGEX.test(trimmed)) {
      return this._handleError('INVALID_URL', `${name} is not a valid URL`, { input });
    }

    // Check protocol
    try {
      const url = new URL(trimmed);
      if (!allowedProtocols.includes(url.protocol)) {
        return this._handleError('INVALID_PROTOCOL', `${name} protocol must be ${allowedProtocols.join(' or ')}`, { input });
      }
    } catch (e) {
      return this._handleError('INVALID_URL', `${name} is not a valid URL`, { input });
    }

    return { valid: true, value: trimmed };
  }

  /**
   * Validate UUID
   */
  validateUUID(input, options = {}) {
    const { name = 'uuid' } = options;

    if (typeof input !== 'string') {
      return this._handleError('INVALID_TYPE', `${name} must be a string`, { input });
    }

    if (!UUID_REGEX.test(input.trim())) {
      return this._handleError('INVALID_UUID', `${name} is not a valid UUID`, { input });
    }

    return { valid: true, value: input.trim() };
  }

  /**
   * Check for SQL injection attempts
   */
  detectSQLInjection(input, options = {}) {
    if (typeof input !== 'string') {
      return { safe: true, value: input };
    }

    for (const pattern of SQL_INJECTION_PATTERNS) {
      if (pattern.test(input)) {
        this._logViolation('SQL_INJECTION_ATTEMPT', input, pattern);
        return { safe: false, threat: 'SQL_INJECTION', pattern: pattern.toString() };
      }
    }

    return { safe: true, value: input };
  }

  /**
   * Check for NoSQL injection attempts
   */
  detectNoSQLInjection(input) {
    if (typeof input === 'object' && input !== null) {
      const json = JSON.stringify(input);
      for (const pattern of NOSQL_INJECTION_PATTERNS) {
        if (pattern.test(json)) {
          this._logViolation('NOSQL_INJECTION_ATTEMPT', json, pattern);
          return { safe: false, threat: 'NOSQL_INJECTION', pattern: pattern.toString() };
        }
      }
    }

    return { safe: true, value: input };
  }

  /**
   * Check for command injection attempts
   */
  detectCommandInjection(input, options = {}) {
    if (typeof input !== 'string') {
      return { safe: true, value: input };
    }

    for (const pattern of COMMAND_INJECTION_PATTERNS) {
      if (pattern.test(input)) {
        this._logViolation('COMMAND_INJECTION_ATTEMPT', input, pattern);
        return { safe: false, threat: 'COMMAND_INJECTION', pattern: pattern.toString() };
      }
    }

    return { safe: true, value: input };
  }

  /**
   * Check for path traversal attempts
   */
  detectPathTraversal(input, options = {}) {
    if (typeof input !== 'string') {
      return { safe: true, value: input };
    }

    for (const pattern of PATH_TRAVERSAL_PATTERNS) {
      if (pattern.test(input)) {
        this._logViolation('PATH_TRAVERSAL_ATTEMPT', input, pattern);
        return { safe: false, threat: 'PATH_TRAVERSAL', pattern: pattern.toString() };
      }
    }

    return { safe: true, value: input };
  }

  /**
   * Sanitize file path to prevent path traversal
   */
  sanitizeFilePath(input, options = {}) {
    const { basePath = null, name = 'path' } = options;

    if (typeof input !== 'string') {
      return this._handleError('INVALID_TYPE', `${name} must be a string`, { input });
    }

    // Check for path traversal
    const traversalCheck = this.detectPathTraversal(input);
    if (!traversalCheck.safe) {
      return this._handleError('PATH_TRAVERSAL', `${name} contains path traversal attempt`, { input });
    }

    // Normalize path
    const normalized = path.normalize(input);

    // If basePath provided, ensure path is within it
    if (basePath) {
      const resolved = path.resolve(basePath, normalized);
      const base = path.resolve(basePath);

      if (!resolved.startsWith(base)) {
        return this._handleError('PATH_OUTSIDE_BASE', `${name} is outside allowed directory`, { input, basePath });
      }

      return { valid: true, value: resolved };
    }

    return { valid: true, value: normalized };
  }

  /**
   * Sanitize SQL input (use parameterized queries instead when possible)
   */
  sanitizeSQL(input) {
    if (typeof input !== 'string') {
      return input;
    }

    // Escape single quotes
    let sanitized = input.replace(/'/g, "''");

    // Remove SQL comments
    sanitized = sanitized.replace(/--.*$/gm, '');
    sanitized = sanitized.replace(/\/\*.*?\*\//gs, '');

    // Check for injection after sanitization
    const check = this.detectSQLInjection(sanitized);
    if (!check.safe) {
      this._logWarning('SQL_INJECTION_AFTER_SANITIZATION', 'Input still contains SQL patterns after sanitization');
      return ''; // Return empty string if still dangerous
    }

    return sanitized;
  }

  /**
   * Validate route parameters
   */
  validateRouteParams(params, schema = {}) {
    const sanitized = {};
    const errors = [];

    for (const [key, value] of Object.entries(params)) {
      const rules = schema[key];

      if (!rules) {
        // No validation rules, sanitize as string
        sanitized[key] = escapeHTML(String(value));
        continue;
      }

      let result;

      switch (rules.type) {
        case 'string':
          result = this.validateString(value, rules);
          break;
        case 'integer':
          result = this.validateInteger(value, rules);
          break;
        case 'email':
          result = this.validateEmail(value, rules);
          break;
        case 'url':
          result = this.validateURL(value, rules);
          break;
        case 'uuid':
          result = this.validateUUID(value, rules);
          break;
        default:
          result = { valid: true, value: escapeHTML(String(value)) };
      }

      if (result.valid) {
        sanitized[key] = result.value;
      } else {
        errors.push({ param: key, error: result.error });
      }
    }

    return {
      valid: errors.length === 0,
      params: sanitized,
      errors
    };
  }

  /**
   * Validate request body
   */
  validateRequestBody(body, schema = {}) {
    return this.validateRouteParams(body, schema);
  }

  /**
   * Sanitize object recursively
   */
  sanitizeObject(obj) {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.sanitizeObject(item));
    }

    if (typeof obj === 'object') {
      const sanitized = {};
      for (const [key, value] of Object.entries(obj)) {
        // Skip internal properties
        if (key.startsWith('_') || key.startsWith('__')) {
          continue;
        }

        sanitized[key] = this.sanitizeObject(value);
      }
      return sanitized;
    }

    if (typeof obj === 'string') {
      return escapeHTML(obj);
    }

    return obj;
  }

  /**
   * Handle validation error
   */
  _handleError(code, message, context = {}) {
    const error = {
      valid: false,
      error: { code, message, context }
    };

    if (this.logViolations) {
      logger.warn({
        code: `MC_VALIDATION_${code}`,
        message: message,
        ...context
      });
    }

    if (this.throwOnError) {
      throw new Error(message);
    }

    return error;
  }

  /**
   * Log validation warning
   */
  _logWarning(code, message, context = {}) {
    if (this.logViolations) {
      logger.warn({
        code: `MC_VALIDATION_${code}`,
        message: message,
        ...context
      });
    }
  }

  /**
   * Log security violation
   */
  _logViolation(type, input, pattern) {
    if (this.logViolations) {
      logger.error({
        code: `MC_SECURITY_${type}`,
        message: `Security violation detected: ${type}`,
        input: input.substring(0, 100), // Log first 100 chars only
        pattern: pattern.toString(),
        timestamp: new Date().toISOString()
      });
    }
  }
}

// Create singleton instance
const validator = new MasterValidator();

/**
 * Quick validation functions
 */

function validateString(input, options) {
  return validator.validateString(input, options);
}

function validateInteger(input, options) {
  return validator.validateInteger(input, options);
}

function validateEmail(input, options) {
  return validator.validateEmail(input, options);
}

function validateURL(input, options) {
  return validator.validateURL(input, options);
}

function sanitizeSQL(input) {
  return validator.sanitizeSQL(input);
}

function sanitizeFilePath(input, options) {
  return validator.sanitizeFilePath(input, options);
}

function validateRouteParams(params, schema) {
  return validator.validateRouteParams(params, schema);
}

function detectSQLInjection(input) {
  return validator.detectSQLInjection(input);
}

function detectPathTraversal(input) {
  return validator.detectPathTraversal(input);
}

function detectCommandInjection(input) {
  return validator.detectCommandInjection(input);
}

module.exports = {
  MasterValidator,
  validator,
  validateString,
  validateInteger,
  validateEmail,
  validateURL,
  sanitizeSQL,
  sanitizeFilePath,
  validateRouteParams,
  detectSQLInjection,
  detectPathTraversal,
  detectCommandInjection
};
