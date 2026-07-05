/**
 * MasterErrorMiddleware - Request/Response error handling middleware
 * Version: 1.0.1
 */

import nodePath from 'node:path';
import { handleControllerError, handleRoutingError, sendErrorResponse } from './MasterBackendErrorHandler.js';
import { logger } from './MasterErrorLogger.js';
import { handleFileReadError } from './MasterBackendErrorHandler.js';

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
        logger.info({
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
 * Uncaught exception handler.
 *
 * @param {Object} [options]
 * @param {boolean} [options.exitOnUncaught=true] - When true (default), the
 *   handler flushes logs and terminates the process. This matches Node's own
 *   documented recommendation — the process is in an unknown state after an
 *   uncaught exception and continuing is unsafe.
 *
 *   Setting this to false keeps the process alive after logging the error.
 *   Use this ONLY if you have audited every async path in your app to be
 *   idempotent and side-effect-safe. In particular, without a supervisor
 *   (pm2 / systemd / K8s), an exit-loop from repeatedly-triggered exceptions
 *   is a DoS surface, but so is continuing execution with a corrupted heap.
 */
function setupGlobalErrorHandlers(options = {}) {
  const exitOnUncaught = options.exitOnUncaught !== false;
  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    // EPIPE/stream errors from logging itself — do not recurse
    if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') {
      try { process.stderr.write(`[MasterController] Stream error suppressed: ${error.code}\n`); } catch (_) {}
      return;
    }

    // Use stderr.write instead of console.error to avoid EPIPE recursion
    try { process.stderr.write(`[MasterController] Uncaught Exception: ${error.message}\n`); } catch (_) {}

    // Extract context from stack trace
    const context = extractUserCodeContext(error.stack);

    // Build enhanced error message
    let enhancedMessage = `Uncaught exception: ${error.message}`;

    if (context && context.triggeringFile) {
      enhancedMessage += `\n\nError Location: ${context.triggeringFile.location}`;
    }

    if (context && context.userFiles.length > 0) {
      enhancedMessage += `\n\nYour Code Involved:`;
      context.userFiles.forEach((file, i) => {
        if (i < 3) {
          enhancedMessage += `\n   ${i + 1}. ${file.location}`;
        }
      });
    }

    if (context && context.frameworkFiles.length > 0) {
      enhancedMessage += `\n\nFramework Files Involved:`;
      context.frameworkFiles.forEach((file, i) => {
        if (i < 2) {
          enhancedMessage += `\n   ${i + 1}. ${file.location}`;
        }
      });
    }

    try { process.stderr.write(enhancedMessage + '\n'); } catch (_) {}

    logger.fatal({
      code: 'MC_ERR_UNCAUGHT_EXCEPTION',
      message: enhancedMessage,
      originalError: error,
      context: context
    });

    // Flush async backends (Sentry, webhook, etc.) before terminating, then
    // exit. The file backend writes synchronously (fs.appendFileSync), so
    // the on-disk log is already flushed; this only awaits network-bound
    // backends. flushAsync has its own 2s timeout — if a backend hangs we
    // still exit promptly, just without that backend's confirmation.
    //
    // Note: the handler itself isn't `async` because Node doesn't await
    // process event listeners. We use .then() chained to process.exit and
    // accept that the process might keep running for a few hundred ms while
    // the flush completes — that's the trade-off for not losing the
    // last-breath telemetry entry.
    if (exitOnUncaught) {
      const exitOnce = () => { try { process.exit(1); } catch (_) {} };
      logger.flushAsync().then(exitOnce, exitOnce);
      // Belt-and-suspenders: hard fallback in case flushAsync's own timeout
      // misbehaves (e.g. a backend that swallowed Promise resolution).
      const hardTimer = setTimeout(exitOnce, 3000);
      if (hardTimer.unref) hardTimer.unref();
    } else {
      // Opt-out path. Best-effort flush without terminating — the caller
      // has explicitly accepted the risk of continuing after an uncaught.
      logger.flushAsync().catch(() => {});
    }
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    try { process.stderr.write(`[MasterController] Unhandled Rejection: ${reason}\n`); } catch (_) {}

    // Extract context from stack trace if available
    const context = reason?.stack ? extractUserCodeContext(reason.stack) : null;

    // Build enhanced error message
    let enhancedMessage = `Unhandled promise rejection: ${reason}`;

    if (context && context.triggeringFile) {
      enhancedMessage += `\n\nError Location: ${context.triggeringFile.location}`;
    }

    if (context && context.userFiles.length > 0) {
      enhancedMessage += `\n\nYour Code Involved:`;
      context.userFiles.forEach((file, i) => {
        if (i < 3) {
          enhancedMessage += `\n   ${i + 1}. ${file.location}`;
        }
      });
    }

    if (enhancedMessage !== `Unhandled promise rejection: ${reason}`) {
      try { process.stderr.write(enhancedMessage + '\n'); } catch (_) {}
    }

    logger.error({
      code: 'MC_ERR_UNHANDLED_REJECTION',
      message: enhancedMessage,
      originalError: reason,
      context: context
    });
  });

  // Handle warnings
  process.on('warning', (warning) => {
    if (isDevelopment) {
      try { process.stderr.write(`[MasterController] Warning: ${warning.message}\n`); } catch (_) {}
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
 * File reader with structured error handling.
 *
 * NOTE (v2.1.1): the name `safeReadFile` was historically misleading — this
 * function catches read errors but does NOT validate or confine `filePath`
 * against traversal, symlinks, or extension. Callers that pass request-
 * derived paths must use `readFileWithinRoot(fs, filePath, allowedRoot)`
 * instead, which resolves the path, checks containment against a required
 * root, and rejects symlinks.
 *
 * The old name is preserved for backward compatibility but is deprecated;
 * prefer `readFileUnchecked` to make the lack of path validation explicit
 * at call sites.
 */
function readFileUnchecked(fs, filePath, encoding = 'utf8') {
  try {
    return {
      success: true,
      content: fs.readFileSync(filePath, encoding),
      error: null
    };
  } catch (error) {
    const mcError = handleFileReadError(error, filePath);

    return {
      success: false,
      content: null,
      error: mcError
    };
  }
}
// Backward-compatible alias — same body, misleading name kept until 3.0.
const safeReadFile = readFileUnchecked;

/**
 * v2.1.1: actually safe file reader. Resolves `filePath` against
 * `allowedRoot` and refuses to read anything that escapes the root or
 * that is a symlink. Callers with attacker-influenced paths MUST use
 * this rather than `safeReadFile` / `readFileUnchecked`.
 *
 * @param {typeof import('node:fs')} fs
 * @param {string} filePath - path to read, absolute or relative
 * @param {string} allowedRoot - directory that the resolved path must live under
 * @param {string} [encoding='utf8']
 */
function readFileWithinRoot(fs, filePath, allowedRoot, encoding = 'utf8') {
  const resolvedRoot = nodePath.resolve(allowedRoot);
  const resolvedTarget = nodePath.resolve(
    nodePath.isAbsolute(filePath) ? filePath : nodePath.join(resolvedRoot, filePath)
  );
  const rootWithSep = resolvedRoot.endsWith(nodePath.sep)
    ? resolvedRoot : resolvedRoot + nodePath.sep;
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(rootWithSep)) {
    const err = new Error(`Refused to read outside allowedRoot: ${filePath}`);
    err.code = 'MC_ERR_READ_OUT_OF_ROOT';
    return { success: false, content: null, error: err };
  }
  try {
    const stat = fs.lstatSync(resolvedTarget);
    if (stat.isSymbolicLink()) {
      const err = new Error(`Refused to read symlink: ${resolvedTarget}`);
      err.code = 'MC_ERR_READ_SYMLINK';
      return { success: false, content: null, error: err };
    }
  } catch (e) {
    return { success: false, content: null, error: e };
  }
  return readFileUnchecked(fs, resolvedTarget, encoding);
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

export { errorHandlerMiddleware,
  requestLoggerMiddleware,
  notFoundMiddleware,
  setupGlobalErrorHandlers,
  safeReadFile,
  readFileUnchecked,
  readFileWithinRoot,
  safeFileExists,
  wrapController,
  performanceTracker };