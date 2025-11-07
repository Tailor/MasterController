/**
 * MasterBackendErrorHandler - Comprehensive backend error handling
 * Handles routing, controller, template, and request errors
 * Version: 1.0.0
 */

const { MasterControllerError } = require('./MasterErrorHandler');
const { logger } = require('./MasterErrorLogger');
const path = require('path');
const fs = require('fs');

const isDevelopment = process.env.NODE_ENV !== 'production' && process.env.master === 'development';

// Backend-specific error codes
const BACKEND_ERROR_CODES = {
  MC_ERR_ROUTE_NOT_FOUND: {
    title: '404 - Route Not Found',
    httpCode: 404,
    severity: 'warning'
  },
  MC_ERR_ROUTE_CONSTRAINT: {
    title: 'Route Constraint Failed',
    httpCode: 500,
    severity: 'error'
  },
  MC_ERR_ROUTE_PROCESS: {
    title: 'Route Processing Failed',
    httpCode: 500,
    severity: 'error'
  },
  MC_ERR_ROUTE_PARAM_SANITIZATION: {
    title: 'Route Parameter Sanitization Failed',
    httpCode: 400,
    severity: 'error'
  },
  MC_ERR_CONTROLLER_NOT_FOUND: {
    title: 'Controller Not Found',
    httpCode: 500,
    severity: 'error'
  },
  MC_ERR_ACTION_NOT_FOUND: {
    title: 'Action Not Found',
    httpCode: 500,
    severity: 'error'
  },
  MC_ERR_TEMPLATE_NOT_FOUND: {
    title: 'Template File Not Found',
    httpCode: 500,
    severity: 'error'
  },
  MC_ERR_TEMPLATE_RENDER: {
    title: 'Template Rendering Failed',
    httpCode: 500,
    severity: 'error'
  },
  MC_ERR_VIEW_NOT_FOUND: {
    title: 'View File Not Found',
    httpCode: 500,
    severity: 'error'
  },
  MC_ERR_CONTROLLER_EXCEPTION: {
    title: 'Controller Action Failed',
    httpCode: 500,
    severity: 'error'
  },
  MC_ERR_REQUEST_PARSE: {
    title: 'Request Parse Error',
    httpCode: 400,
    severity: 'error'
  },
  MC_ERR_VALIDATION: {
    title: 'Validation Error',
    httpCode: 422,
    severity: 'warning'
  },
  MC_ERR_DATABASE: {
    title: 'Database Error',
    httpCode: 500,
    severity: 'error'
  },
  MC_ERR_FILE_READ: {
    title: 'File Read Error',
    httpCode: 500,
    severity: 'error'
  },
  MC_ERR_MIDDLEWARE: {
    title: 'Middleware Error',
    httpCode: 500,
    severity: 'error'
  },
  MC_ERR_SESSION: {
    title: 'Session Error',
    httpCode: 500,
    severity: 'error'
  },
  MC_ERR_UNAUTHORIZED: {
    title: 'Unauthorized Access',
    httpCode: 401,
    severity: 'warning'
  },
  MC_ERR_FORBIDDEN: {
    title: 'Forbidden',
    httpCode: 403,
    severity: 'warning'
  },
  MC_ERR_METHOD_NOT_ALLOWED: {
    title: 'Method Not Allowed',
    httpCode: 405,
    severity: 'warning'
  }
};

/**
 * Render 404 error page
 */
function render404Page(requestPath, suggestions = []) {
  const title = '404 - Page Not Found';

  if (isDevelopment) {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 600px;
      width: 100%;
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      padding: 40px;
      text-align: center;
      color: white;
    }
    .header h1 {
      font-size: 72px;
      font-weight: 900;
      margin-bottom: 10px;
    }
    .header p {
      font-size: 20px;
      opacity: 0.9;
    }
    .content {
      padding: 40px;
    }
    .path {
      background: #f3f4f6;
      padding: 16px;
      border-radius: 8px;
      font-family: 'Courier New', monospace;
      font-size: 14px;
      color: #1f2937;
      word-break: break-all;
      margin-bottom: 24px;
    }
    .suggestions {
      margin: 24px 0;
    }
    .suggestions h3 {
      font-size: 16px;
      color: #374151;
      margin-bottom: 12px;
    }
    .suggestions ul {
      list-style: none;
    }
    .suggestions li {
      background: #ecfdf5;
      padding: 12px 16px;
      margin-bottom: 8px;
      border-radius: 6px;
      border-left: 3px solid #10b981;
    }
    .suggestions a {
      color: #059669;
      text-decoration: none;
      font-weight: 600;
    }
    .suggestions a:hover {
      text-decoration: underline;
    }
    .actions {
      display: flex;
      gap: 12px;
      margin-top: 24px;
    }
    .btn {
      flex: 1;
      padding: 12px 24px;
      border: none;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
      text-decoration: none;
      transition: all 0.2s;
    }
    .btn-primary {
      background: #3b82f6;
      color: white;
    }
    .btn-primary:hover {
      background: #2563eb;
    }
    .btn-secondary {
      background: #e5e7eb;
      color: #374151;
    }
    .btn-secondary:hover {
      background: #d1d5db;
    }
    .footer {
      padding: 20px 40px;
      background: #f9fafb;
      text-align: center;
      color: #6b7280;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>404</h1>
      <p>Page Not Found</p>
    </div>
    <div class="content">
      <div class="path">${requestPath}</div>
      <p style="color: #6b7280; line-height: 1.6;">
        The page you're looking for doesn't exist or has been moved.
      </p>
      ${suggestions.length > 0 ? `
      <div class="suggestions">
        <h3>Did you mean?</h3>
        <ul>
          ${suggestions.map(s => `<li><a href="${s.path}">${s.path}</a></li>`).join('')}
        </ul>
      </div>
      ` : ''}
      <div class="actions">
        <a href="/" class="btn btn-primary">Go Home</a>
        <a href="javascript:history.back()" class="btn btn-secondary">Go Back</a>
      </div>
    </div>
    <div class="footer">
      MasterController Framework
    </div>
  </div>
</body>
</html>
    `.trim();
  }

  // Production 404
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f9fafb;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      margin: 0;
    }
    .container {
      text-align: center;
      max-width: 500px;
    }
    h1 {
      font-size: 120px;
      color: #3b82f6;
      margin: 0;
    }
    p {
      font-size: 20px;
      color: #6b7280;
      margin: 20px 0 40px;
    }
    a {
      display: inline-block;
      padding: 12px 32px;
      background: #3b82f6;
      color: white;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
    }
    a:hover {
      background: #2563eb;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>404</h1>
    <p>Page not found</p>
    <a href="/">Return Home</a>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Render 500 error page
 */
function render500Page(error, requestPath) {
  const title = '500 - Server Error';

  if (isDevelopment) {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1f2937;
      color: #f3f4f6;
      padding: 20px;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    .header {
      background: #dc2626;
      padding: 30px;
      border-radius: 8px;
      margin-bottom: 20px;
    }
    .header h1 {
      font-size: 36px;
      margin-bottom: 10px;
    }
    .header p {
      font-size: 18px;
      opacity: 0.9;
    }
    .section {
      background: #374151;
      padding: 24px;
      border-radius: 8px;
      margin-bottom: 20px;
    }
    .section h2 {
      font-size: 20px;
      margin-bottom: 16px;
      color: #60a5fa;
    }
    .code {
      background: #1f2937;
      padding: 16px;
      border-radius: 4px;
      font-family: 'Courier New', monospace;
      font-size: 14px;
      overflow-x: auto;
      border-left: 4px solid #dc2626;
    }
    .path {
      color: #fbbf24;
      font-family: 'Courier New', monospace;
    }
    .stack {
      color: #f87171;
      white-space: pre-wrap;
      line-height: 1.6;
    }
    .btn {
      display: inline-block;
      padding: 10px 20px;
      background: #3b82f6;
      color: white;
      text-decoration: none;
      border-radius: 6px;
      margin-top: 20px;
    }
    .btn:hover {
      background: #2563eb;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>❌ 500 - Server Error</h1>
      <p>An error occurred while processing your request</p>
    </div>

    <div class="section">
      <h2>Request Path</h2>
      <div class="code">
        <span class="path">${requestPath || '(unknown)'}</span>
      </div>
    </div>

    ${error ? `
    <div class="section">
      <h2>Error Message</h2>
      <div class="code">
        ${error.message || 'Unknown error'}
      </div>
    </div>

    ${error.stack ? `
    <div class="section">
      <h2>Stack Trace</h2>
      <div class="code">
        <div class="stack">${error.stack}</div>
      </div>
    </div>
    ` : ''}
    ` : ''}

    <a href="/" class="btn">Go Home</a>
  </div>
</body>
</html>
    `.trim();
  }

  // Production 500
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f9fafb;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      margin: 0;
    }
    .container {
      text-align: center;
      max-width: 500px;
    }
    .icon {
      font-size: 80px;
      margin-bottom: 20px;
    }
    h1 {
      font-size: 32px;
      color: #1f2937;
      margin-bottom: 16px;
    }
    p {
      font-size: 18px;
      color: #6b7280;
      margin-bottom: 32px;
      line-height: 1.6;
    }
    a {
      display: inline-block;
      padding: 12px 32px;
      background: #3b82f6;
      color: white;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
    }
    a:hover {
      background: #2563eb;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">😞</div>
    <h1>Something went wrong</h1>
    <p>We're sorry, but something went wrong on our end. We've been notified and are working to fix it.</p>
    <a href="/">Return Home</a>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Handle controller errors
 */
function handleControllerError(error, controllerName, actionName, requestPath, routeDef = null) {
  // Build details message with route information if available
  let details = `Action: ${actionName}\nPath: ${requestPath}`;

  if (routeDef) {
    details += `\n\nRoute Definition:\n  Path: ${routeDef.path}\n  Controller: ${routeDef.toController}#${routeDef.toAction}\n  Method: ${routeDef.type.toUpperCase()}`;
  }

  const mcError = new MasterControllerError({
    code: error.message && error.message.includes('not found') ? 'MC_ERR_CONTROLLER_NOT_FOUND' : 'MC_ERR_CONTROLLER_EXCEPTION',
    message: error.message && error.message.includes('not found')
      ? `Controller not found: ${controllerName}Controller`
      : `Controller action threw an error: ${error.message}`,
    file: `app/controllers/${controllerName}Controller.js`,
    details: details,
    originalError: error,
    context: {
      controller: controllerName,
      action: actionName,
      requestPath: requestPath,
      route: routeDef
    }
  });

  if (isDevelopment) {
    console.error(mcError.format());
  }

  logger.error({
    code: mcError.code,
    message: mcError.message,
    controller: controllerName,
    action: actionName,
    route: requestPath,
    routeDef: routeDef,
    originalError: error
  });

  return mcError;
}

/**
 * Handle routing errors
 */
function handleRoutingError(requestPath, routes = [], errorContext = null) {
  // Check if this is a route processing error (not a 404)
  if (errorContext && errorContext.type === 'CONSTRAINT_ERROR') {
    const route = errorContext.route;
    const mcError = new MasterControllerError({
      code: 'MC_ERR_ROUTE_CONSTRAINT',
      message: `Route constraint failed: ${route.path} → ${route.toController}#${route.toAction}`,
      details: `The constraint function for this route threw an error:\n\n${errorContext.error.message}\n\nRoute Definition:\n  Path: ${route.path}\n  Controller: ${route.toController}\n  Action: ${route.toAction}\n  Method: ${route.type.toUpperCase()}\n\nRequest:\n  Path: ${requestPath}`,
      file: `config/routes.js`,
      context: {
        route: route,
        requestPath: requestPath,
        errorType: 'constraint'
      },
      originalError: errorContext.error
    });

    if (isDevelopment) {
      console.error(mcError.format());
    }

    logger.error({
      code: mcError.code,
      message: mcError.message,
      route: route,
      requestPath: requestPath,
      originalError: errorContext.error
    });

    return mcError;
  }

  // Check if this is a route processing error
  if (errorContext && errorContext.type === 'ROUTE_PROCESS_ERROR') {
    const route = errorContext.route;
    const mcError = new MasterControllerError({
      code: 'MC_ERR_ROUTE_PROCESS',
      message: `Failed to process route: ${route.path} → ${route.toController}#${route.toAction}`,
      details: `An error occurred while processing this route:\n\n${errorContext.error.message}\n\nRoute Definition:\n  Path: ${route.path}\n  Controller: ${route.toController}\n  Action: ${route.toAction}\n  Method: ${route.type.toUpperCase()}\n\nRequest:\n  Path: ${requestPath}\n  Method: ${errorContext.requestMethod || 'GET'}`,
      file: `config/routes.js`,
      context: {
        route: route,
        requestPath: requestPath,
        errorType: 'processing'
      },
      originalError: errorContext.error
    });

    if (isDevelopment) {
      console.error(mcError.format());
    }

    logger.error({
      code: mcError.code,
      message: mcError.message,
      route: route,
      requestPath: requestPath,
      originalError: errorContext.error
    });

    return mcError;
  }

  // Standard 404 error
  const mcError = new MasterControllerError({
    code: 'MC_ERR_ROUTE_NOT_FOUND',
    message: `No route found for: ${requestPath}`,
    details: `The requested path does not match any defined routes.\n\nRegistered routes: ${routes.length}\n\nCheck your route definitions in config/routes.js`,
    suggestions: findSimilarRoutes(requestPath, routes),
    context: { requestPath, availableRoutes: routes.length }
  });

  if (isDevelopment) {
    console.warn(mcError.format());
  }

  logger.warn({
    code: mcError.code,
    message: mcError.message,
    route: requestPath
  });

  return mcError;
}

/**
 * Find similar routes for suggestions
 */
function findSimilarRoutes(requestPath, routes) {
  if (!routes || routes.length === 0) return [];

  const { levenshteinDistance } = require('./MasterErrorHandler');

  const similar = routes
    .map(route => ({
      path: route.path || route,
      distance: levenshteinDistance(requestPath, route.path || route)
    }))
    .filter(r => r.distance <= 5)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map(r => ({ path: r.path }));

  return similar;
}

/**
 * Handle template errors
 */
function handleTemplateError(error, templatePath, data) {
  const mcError = new MasterControllerError({
    code: error.code === 'ENOENT' ? 'MC_ERR_TEMPLATE_NOT_FOUND' : 'MC_ERR_TEMPLATE_RENDER',
    message: error.code === 'ENOENT'
      ? `Template file not found: ${templatePath}`
      : `Template rendering failed: ${error.message}`,
    file: templatePath,
    originalError: error,
    details: error.code === 'ENOENT'
      ? 'The template file does not exist. Check the file path and ensure the file exists.'
      : null
  });

  if (isDevelopment) {
    console.error(mcError.format());
  }

  logger.error({
    code: mcError.code,
    message: mcError.message,
    file: templatePath,
    originalError: error
  });

  return mcError;
}

/**
 * Handle file read errors
 */
function handleFileReadError(error, filePath) {
  const mcError = new MasterControllerError({
    code: 'MC_ERR_FILE_READ',
    message: `Failed to read file: ${filePath}`,
    file: filePath,
    originalError: error,
    details: error.code === 'ENOENT'
      ? 'File does not exist'
      : error.code === 'EACCES'
      ? 'Permission denied'
      : error.message
  });

  if (isDevelopment) {
    console.error(mcError.format());
  }

  logger.error({
    code: mcError.code,
    message: mcError.message,
    file: filePath,
    originalError: error
  });

  return mcError;
}

/**
 * Send error response to client
 */
function sendErrorResponse(response, error, requestPath) {
  if (!response || response.headersSent) {
    return;
  }

  const httpCode = BACKEND_ERROR_CODES[error.code]?.httpCode || 500;
  const isNotFound = httpCode === 404;

  try {
    if (isNotFound) {
      response.writeHead(404, { 'Content-Type': 'text/html' });
      response.end(render404Page(requestPath, error.suggestions || []));
    } else {
      response.writeHead(httpCode, { 'Content-Type': 'text/html' });

      if (isDevelopment) {
        // Development: Show detailed error
        response.end(render500Page(error.originalError || error, requestPath));
      } else {
        // Production: Show friendly error
        response.end(render500Page(null, requestPath));
      }
    }
  } catch (sendError) {
    console.error('[MasterController] Failed to send error response:', sendError);
  }
}

module.exports = {
  BACKEND_ERROR_CODES,
  render404Page,
  render500Page,
  handleControllerError,
  handleRoutingError,
  handleTemplateError,
  handleFileReadError,
  sendErrorResponse
};
