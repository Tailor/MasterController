// version 1.0.1
// MasterController Event Handler Validator - Prevent code injection in @event attributes

/**
 * Validates @event attribute expressions to prevent:
 * - Arbitrary code execution
 * - XSS through event handlers
 * - Malicious function calls
 */

const { logger } = require('../error/MasterErrorLogger');
const { MasterControllerError } = require('../error/MasterErrorHandler');

// Valid patterns for event handler expressions
const VALID_PATTERNS = [
  // this.methodName
  /^this\.[a-zA-Z_$][a-zA-Z0-9_$]*$/,

  // this.methodName()
  /^this\.[a-zA-Z_$][a-zA-Z0-9_$]*\(\)$/,

  // this.methodName(arg1, arg2)
  /^this\.[a-zA-Z_$][a-zA-Z0-9_$]*\([^)]*\)$/,

  // component.methodName (for child components)
  /^[a-zA-Z_$][a-zA-Z0-9_$]*\.[a-zA-Z_$][a-zA-Z0-9_$]*$/,

  // component.methodName()
  /^[a-zA-Z_$][a-zA-Z0-9_$]*\.[a-zA-Z_$][a-zA-Z0-9_$]*\(\)$/,
];

// Dangerous patterns that should be blocked
const DANGEROUS_PATTERNS = [
  // eval, Function constructor
  /\beval\s*\(/i,
  /new\s+Function\s*\(/i,

  // setTimeout, setInterval with string
  /setTimeout\s*\(\s*["'`]/i,
  /setInterval\s*\(\s*["'`]/i,

  // Script injection
  /<script/i,
  /javascript:/i,
  /on\w+\s*=/i, // onclick=, onerror=, etc.

  // Document/window manipulation
  /document\.\w+\s*=/i,
  /window\.\w+\s*=/i,
  /location\s*=/i,

  // Code execution
  /\.constructor\s*\(/i,
  /__proto__/i,
  /prototype/i,

  // Dangerous characters
  /[;&|`$]/,

  // Import/require
  /\bimport\s*\(/i,
  /\brequire\s*\(/i,
];

// Whitelist of safe built-in methods
const SAFE_METHODS = [
  'preventDefault',
  'stopPropagation',
  'stopImmediatePropagation',
  'log',
  'warn',
  'error'
];

class EventHandlerValidator {
  constructor(options = {}) {
    this.strict = options.strict !== false;
    this.throwOnError = options.throwOnError || false;
    this.logViolations = options.logViolations !== false;
  }

  /**
   * Validate event handler expression
   */
  validateHandler(expression, context = {}) {
    if (!expression || typeof expression !== 'string') {
      return this._handleError(
        'INVALID_EXPRESSION',
        'Event handler expression must be a non-empty string',
        { expression, context }
      );
    }

    const trimmed = expression.trim();

    // Check for empty expression
    if (trimmed.length === 0) {
      return this._handleError(
        'EMPTY_EXPRESSION',
        'Event handler expression cannot be empty',
        { expression, context }
      );
    }

    // Check for dangerous patterns first
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(trimmed)) {
        return this._handleError(
          'DANGEROUS_PATTERN',
          `Event handler contains dangerous pattern: ${pattern.toString()}`,
          { expression: trimmed, pattern: pattern.toString(), context }
        );
      }
    }

    // Check if expression matches valid patterns
    const isValid = VALID_PATTERNS.some(pattern => pattern.test(trimmed));

    if (!isValid && this.strict) {
      return this._handleError(
        'INVALID_PATTERN',
        'Event handler expression does not match allowed patterns',
        { expression: trimmed, context }
      );
    }

    // Additional validation for specific patterns
    const validation = this._validateSpecificPattern(trimmed, context);
    if (!validation.valid) {
      return validation;
    }

    return { valid: true, expression: trimmed };
  }

  /**
   * Validate specific pattern details
   */
  _validateSpecificPattern(expression, context) {
    // Check for this.methodName pattern
    if (expression.startsWith('this.')) {
      const methodName = expression.substring(5).replace(/\(.*\)$/, '');

      if (methodName.length === 0) {
        return this._handleError(
          'INVALID_METHOD',
          'Method name cannot be empty',
          { expression, context }
        );
      }

      // Check for reserved JavaScript keywords
      if (this._isReservedKeyword(methodName)) {
        return this._handleError(
          'RESERVED_KEYWORD',
          `Cannot use reserved keyword as method name: ${methodName}`,
          { expression, methodName, context }
        );
      }
    }

    // Check for arguments if present
    if (expression.includes('(') && expression.includes(')')) {
      const argsMatch = expression.match(/\(([^)]*)\)/);
      if (argsMatch && argsMatch[1].trim().length > 0) {
        const args = argsMatch[1];
        const argValidation = this._validateArguments(args, expression, context);
        if (!argValidation.valid) {
          return argValidation;
        }
      }
    }

    return { valid: true };
  }

  /**
   * Validate function arguments
   */
  _validateArguments(argsString, expression, context) {
    // Split by comma, but respect nested parentheses
    const args = this._splitArguments(argsString);

    for (const arg of args) {
      const trimmedArg = arg.trim();

      // Allow: numbers, strings, booleans, null, undefined, event, this, simple property access
      const validArgPatterns = [
        /^[0-9]+$/, // numbers
        /^[0-9]+\.[0-9]+$/, // decimals
        /^["'].*["']$/, // strings
        /^`.*`$/, // template strings (limited)
        /^true$/, // boolean true
        /^false$/, // boolean false
        /^null$/, // null
        /^undefined$/, // undefined
        /^event$/, // event object
        /^this$/, // this reference
        /^this\.[a-zA-Z_$][a-zA-Z0-9_$]*$/, // this.property
        /^event\.[a-zA-Z_$][a-zA-Z0-9_$.]*$/, // event.property.nested
      ];

      const isValidArg = validArgPatterns.some(pattern => pattern.test(trimmedArg));

      if (!isValidArg) {
        return this._handleError(
          'INVALID_ARGUMENT',
          `Invalid argument in event handler: ${trimmedArg}`,
          { expression, argument: trimmedArg, context }
        );
      }

      // Check for dangerous content in string arguments
      if (/^["'`]/.test(trimmedArg)) {
        for (const pattern of DANGEROUS_PATTERNS) {
          if (pattern.test(trimmedArg)) {
            return this._handleError(
              'DANGEROUS_ARGUMENT',
              `Dangerous content in argument: ${trimmedArg}`,
              { expression, argument: trimmedArg, context }
            );
          }
        }
      }
    }

    return { valid: true };
  }

  /**
   * Split arguments respecting nested structures
   */
  _splitArguments(argsString) {
    const args = [];
    let current = '';
    let depth = 0;
    let inString = false;
    let stringChar = '';

    for (let i = 0; i < argsString.length; i++) {
      const char = argsString[i];

      if (!inString) {
        if (char === '"' || char === "'" || char === '`') {
          inString = true;
          stringChar = char;
          current += char;
        } else if (char === '(' || char === '[' || char === '{') {
          depth++;
          current += char;
        } else if (char === ')' || char === ']' || char === '}') {
          depth--;
          current += char;
        } else if (char === ',' && depth === 0) {
          args.push(current);
          current = '';
        } else {
          current += char;
        }
      } else {
        current += char;
        if (char === stringChar && argsString[i - 1] !== '\\') {
          inString = false;
        }
      }
    }

    if (current.trim().length > 0) {
      args.push(current);
    }

    return args;
  }

  /**
   * Check if identifier is a reserved JavaScript keyword
   */
  _isReservedKeyword(identifier) {
    const reserved = [
      'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
      'default', 'delete', 'do', 'else', 'export', 'extends', 'finally',
      'for', 'function', 'if', 'import', 'in', 'instanceof', 'new',
      'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof',
      'var', 'void', 'while', 'with', 'yield'
    ];

    return reserved.includes(identifier);
  }

  /**
   * Validate @event attribute (attribute name + expression)
   */
  validateEventAttribute(attrName, attrValue, context = {}) {
    // Validate attribute name format
    if (!attrName || !attrName.startsWith('@')) {
      return this._handleError(
        'INVALID_ATTRIBUTE_NAME',
        'Event attribute must start with @',
        { attrName, attrValue, context }
      );
    }

    // Extract event type and component name
    // Format: @eventType-componentName or @eventType
    const eventName = attrName.substring(1); // Remove @
    const parts = eventName.split('-');

    if (parts.length < 1) {
      return this._handleError(
        'INVALID_EVENT_NAME',
        'Event name cannot be empty',
        { attrName, attrValue, context }
      );
    }

    // Validate event type (first part)
    const eventType = parts[0];
    if (!/^[a-z][a-z0-9]*$/.test(eventType)) {
      return this._handleError(
        'INVALID_EVENT_TYPE',
        'Event type must be lowercase alphanumeric',
        { attrName, eventType, attrValue, context }
      );
    }

    // Validate component name if present (second part)
    if (parts.length > 1) {
      const componentName = parts.slice(1).join('-');
      if (!/^[a-z][a-z0-9-]*$/.test(componentName)) {
        return this._handleError(
          'INVALID_COMPONENT_NAME',
          'Component name must be lowercase with hyphens',
          { attrName, componentName, attrValue, context }
        );
      }
    }

    // Validate handler expression
    return this.validateHandler(attrValue, { ...context, attrName });
  }

  /**
   * Sanitize event handler expression (remove dangerous content)
   */
  sanitizeHandler(expression) {
    if (!expression || typeof expression !== 'string') {
      return '';
    }

    let sanitized = expression.trim();

    // Remove dangerous content
    for (const pattern of DANGEROUS_PATTERNS) {
      sanitized = sanitized.replace(pattern, '');
    }

    // Validate after sanitization
    const validation = this.validateHandler(sanitized);
    if (!validation.valid) {
      if (this.logViolations) {
        logger.warn({
          code: 'MC_SECURITY_HANDLER_SANITIZED',
          message: 'Event handler sanitized but still invalid',
          original: expression,
          sanitized: sanitized
        });
      }
      return ''; // Return empty string if still invalid
    }

    return sanitized;
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
      logger.error({
        code: `MC_SECURITY_EVENT_${code}`,
        message: message,
        ...context
      });
    }

    if (this.throwOnError) {
      throw new MasterControllerError({
        code: `MC_SECURITY_EVENT_${code}`,
        message: message,
        ...context
      });
    }

    return error;
  }
}

// Create singleton instance
const validator = new EventHandlerValidator();

/**
 * Quick validation functions
 */

function validateHandler(expression, context) {
  return validator.validateHandler(expression, context);
}

function validateEventAttribute(attrName, attrValue, context) {
  return validator.validateEventAttribute(attrName, attrValue, context);
}

function sanitizeHandler(expression) {
  return validator.sanitizeHandler(expression);
}

/**
 * Safe event handler wrapper for use in components
 */
function createSafeHandler(handler, component) {
  return function safeEventHandler(event) {
    try {
      // Validate event object
      if (!event || typeof event !== 'object') {
        logger.warn({
          code: 'MC_SECURITY_INVALID_EVENT',
          message: 'Invalid event object passed to handler'
        });
        return;
      }

      // Call handler with proper context
      return handler.call(component, event);
    } catch (error) {
      logger.error({
        code: 'MC_SECURITY_HANDLER_ERROR',
        message: 'Error in event handler',
        error: error.message,
        stack: error.stack
      });

      // Rethrow in development
      if (process.env.NODE_ENV === 'development') {
        throw error;
      }
    }
  };
}

module.exports = {
  EventHandlerValidator,
  validator,
  validateHandler,
  validateEventAttribute,
  sanitizeHandler,
  createSafeHandler,
  VALID_PATTERNS,
  DANGEROUS_PATTERNS
};
