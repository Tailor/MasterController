/**
 * MasterErrorMiddleware - Request/Response error handling middleware
 * Version: 1.0.0
 */

const { handleControllerError, handleRoutingError, sendErrorResponse } = require('./MasterBackendErrorHandler');
const { logger } = require('./MasterErrorLogger');

const isDevelopment = process.env.NODE_ENV !== 'production' && process.env.master === 'development';

/**
 * Global error handler middleware
 * Wrap all controller actions with this
 */
function errorHandlerMiddleware(handler, controllerName, actionName) {
  return async function wrappedHandler(requestObject) {
    const startTime = Date.now();

    try {
      // Execute the actual handler
      const result = await Promise.resolve(handler.call(this, requestObject));

      // Log successful request in development
      if (isDevelopment) {
        const duration = Date.now() - startTime;
        logger.debug({
          code: 'MC_INFO_REQUEST_SUCCESS',
          message: `${controllerName}#${actionName} completed`,
          context: {
            duration,
            path: requestObject.pathName,
            method: requestObject.type
          }
        });
      }

      return result;

    } catch (error) {
      const duration = Date.now() - startTime;

      // Handle the error
      const mcError = handleControllerError(
        error,
        controllerName,
        actionName,
        requestObject.pathName
      );

      // Send error response
      sendErrorResponse(
        requestObject.response,
        mcError,
        requestObject.pathName
      );

      // Log to monitoring
      logger.error({
        code: mcError.code,
        message: mcError.message,
        controller: controllerName,
        action: actionName,
        route: requestObject.pathName,
        method: requestObject.type,
        duration,
        originalError: error,
        stack: error.stack
      });

      // Don't re-throw - error has been handled
      return null;
    }
  };
}

/**
 * Request logging middleware
 */
function requestLoggerMiddleware() {
  return function(requestObject, next) {
    const startTime = Date.now();

    logger.info({
      code: 'MC_INFO_REQUEST_START',
      message: `${requestObject.type} ${requestObject.pathName}`,
      context: {
        method: requestObject.type,
        path: requestObject.pathName,
        params: requestObject.params,
        query: requestObject.query,
        ip: requestObject.request.connection?.remoteAddress
      }
    });

    // Continue to next middleware
    if (typeof next === 'function') {
      next();
    }
  };
}

/**
 * 404 handler middleware
 */
function notFoundMiddleware(requestObject) {
  const mcError = handleRoutingError(
    requestObject.pathName,
    [] // Would need to pass available routes here
  );

  sendErrorResponse(
    requestObject.response,
    mcError,
    requestObject.pathName
  );
}

/**
 * Extract user code context from stack trace
 */
function extractUserCodeContext(stack) {
  if (!stack) return null;

  const lines = stack.split('\n');
  const userFiles = [];
  const frameworkFiles = [];

  for (const line of lines) {
    // Skip the error message line
    if (!line.trim().startsWith('at ')) continue;

    // Extract file path from stack line
    const match = line.match(/\((.+?):(\d+):(\d+)\)|at (.+?):(\d+):(\d+)/);
    if (!match) continue;

    const filePath = match[1] || match[4];
    const lineNum = match[2] || match[5];
    const colNum = match[3] || match[6];

    if (!filePath) continue;

    // Categorize as user code or framework code
    const isFramework = filePath.includes('node_modules/mastercontroller');
    const isNodeInternal = filePath.includes('node:internal') || filePath.includes('/lib/internal/');

    if (isNodeInternal) continue;

    const fileInfo = {
      file: filePath,
      line: lineNum,
      column: colNum,
      location: `${filePath}:${lineNum}:${colNum}`
    };

    if (isFramework) {
      frameworkFiles.push(fileInfo);
    } else {
      userFiles.push(fileInfo);
    }
  }

  return {
    userFiles,
    frameworkFiles,
    triggeringFile: userFiles[0] || frameworkFiles[0] || null
  };
}

/**
 * Uncaught exception handler
 */
function setupGlobalErrorHandlers() {
  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    console.error('[MasterController] Uncaught Exception:', error);

    // Extract context from stack trace
    const context = extractUserCodeContext(error.stack);

    // Build enhanced error message
    let enhancedMessage = `Uncaught exception: ${error.message}`;

    if (context && context.triggeringFile) {
      enhancedMessage += `\n\n🔍 Error Location: ${context.triggeringFile.location}`;
    }

    if (context && context.userFiles.length > 0) {
      enhancedMessage += `\n\n📂 Your Code Involved:`;
      context.userFiles.forEach((file, i) => {
        if (i < 3) { // Show first 3 user files
          enhancedMessage += `\n   ${i + 1}. ${file.location}`;
        }
      });
    }

    if (context && context.frameworkFiles.length > 0) {
      enhancedMessage += `\n\n🔧 Framework Files Involved:`;
      context.frameworkFiles.forEach((file, i) => {
        if (i < 2) { // Show first 2 framework files
          enhancedMessage += `\n   ${i + 1}. ${file.location}`;
        }
      });
    }

    console.error(enhancedMessage);

    logger.fatal({
      code: 'MC_ERR_UNCAUGHT_EXCEPTION',
      message: enhancedMessage,
      originalError: error,
      stack: error.stack,
      context: context
    });

    // Give logger time to write, then exit
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[MasterController] Unhandled Rejection:', reason);

    // Extract context from stack trace if available
    const context = reason?.stack ? extractUserCodeContext(reason.stack) : null;

    // Build enhanced error message
    let enhancedMessage = `Unhandled promise rejection: ${reason}`;

    if (context && context.triggeringFile) {
      enhancedMessage += `\n\n🔍 Error Location: ${context.triggeringFile.location}`;
    }

    if (context && context.userFiles.length > 0) {
      enhancedMessage += `\n\n📂 Your Code Involved:`;
      context.userFiles.forEach((file, i) => {
        if (i < 3) { // Show first 3 user files
          enhancedMessage += `\n   ${i + 1}. ${file.location}`;
        }
      });
    }

    if (enhancedMessage !== `Unhandled promise rejection: ${reason}`) {
      console.error(enhancedMessage);
    }

    logger.error({
      code: 'MC_ERR_UNHANDLED_REJECTION',
      message: enhancedMessage,
      originalError: reason,
      stack: reason?.stack,
      context: context
    });
  });

  // Handle warnings
  process.on('warning', (warning) => {
    if (isDevelopment) {
      console.warn('[MasterController] Warning:', warning);
    }

    logger.warn({
      code: 'MC_WARN_PROCESS_WARNING',
      message: warning.message,
      context: {
        name: warning.name,
        stack: warning.stack
      }
    });
  });
}

/**
 * Safe file reader with error handling
 */
function safeReadFile(fs, filePath, encoding = 'utf8') {
  try {
    return {
      success: true,
      content: fs.readFileSync(filePath, encoding),
      error: null
    };
  } catch (error) {
    const { handleFileReadError } = require('./MasterBackendErrorHandler');
    const mcError = handleFileReadError(error, filePath);

    return {
      success: false,
      content: null,
      error: mcError
    };
  }
}

/**
 * Safe file existence check
 */
function safeFileExists(fs, filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (error) {
    logger.warn({
      code: 'MC_WARN_FILE_CHECK',
      message: `Could not check if file exists: ${filePath}`,
      originalError: error
    });
    return false;
  }
}

/**
 * Wrap controller class with error handling
 */
function wrapController(ControllerClass, controllerName) {
  const wrappedMethods = {};

  // Get all methods from the controller
  const methodNames = Object.getOwnPropertyNames(ControllerClass.prototype);

  methodNames.forEach(methodName => {
    if (methodName === 'constructor') return;

    const originalMethod = ControllerClass.prototype[methodName];

    if (typeof originalMethod === 'function') {
      // Wrap each method with error handling
      wrappedMethods[methodName] = errorHandlerMiddleware(
        originalMethod,
        controllerName,
        methodName
      );
    }
  });

  // Create new class with wrapped methods
  const WrappedController = class extends ControllerClass {
    constructor(...args) {
      super(...args);

      // Apply wrapped methods
      Object.keys(wrappedMethods).forEach(methodName => {
        this[methodName] = wrappedMethods[methodName].bind(this);
      });
    }
  };

  return WrappedController;
}

/**
 * Performance tracking middleware
 */
function performanceMiddleware() {
  const requests = new Map();

  return {
    start(requestId, requestObject) {
      requests.set(requestId, {
        startTime: Date.now(),
        path: requestObject.pathName,
        method: requestObject.type
      });
    },

    end(requestId) {
      const req = requests.get(requestId);
      if (!req) return;

      const duration = Date.now() - req.startTime;

      if (duration > 1000) {
        logger.warn({
          code: 'MC_WARN_SLOW_REQUEST',
          message: `Slow request detected (${duration}ms)`,
          context: {
            duration,
            path: req.path,
            method: req.method
          }
        });
      }

      requests.delete(requestId);
    },

    getStats() {
      return {
        activeRequests: requests.size,
        requests: Array.from(requests.values())
      };
    }
  };
}

const performanceTracker = performanceMiddleware();

module.exports = {
  errorHandlerMiddleware,
  requestLoggerMiddleware,
  notFoundMiddleware,
  setupGlobalErrorHandlers,
  safeReadFile,
  safeFileExists,
  wrapController,
  performanceTracker
};
