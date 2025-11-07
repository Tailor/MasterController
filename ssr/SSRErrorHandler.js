/**
 * SSRErrorHandler - Server-side rendering error handling
 * Handles component render failures with graceful fallbacks
 * Version: 1.0.0
 */

const { MasterControllerError } = require('../MasterErrorHandler');

const isDevelopment = process.env.NODE_ENV !== 'production' && process.env.master === 'development';

/**
 * Render error component for development mode
 */
function renderErrorComponent(options = {}) {
  const {
    component,
    error,
    stack,
    file,
    line,
    details
  } = options;

  const errorObj = new MasterControllerError({
    code: 'MC_ERR_COMPONENT_RENDER_FAILED',
    message: error || 'Component failed to render on server',
    component,
    file,
    line,
    details: details || stack,
    originalError: options.originalError
  });

  // Return full HTML error page in development
  return errorObj.toHTML();
}

/**
 * Render fallback component for production mode
 */
function renderFallback(componentName, options = {}) {
  const { showSkeleton = true, customMessage } = options;

  if (showSkeleton) {
    return `
      <div class="mc-fallback" data-component="${componentName}" style="
        padding: 20px;
        background: #f9fafb;
        border-radius: 8px;
        border: 1px dashed #d1d5db;
        min-height: 100px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #6b7280;
      ">
        <div class="mc-fallback-content">
          ${customMessage || ''}
          <div class="skeleton-loader" style="
            width: 100%;
            height: 20px;
            background: linear-gradient(90deg, #e5e7eb 25%, #f3f4f6 50%, #e5e7eb 75%);
            background-size: 200% 100%;
            animation: skeleton-loading 1.5s ease-in-out infinite;
            border-radius: 4px;
          "></div>
        </div>
        <style>
          @keyframes skeleton-loading {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
          }
        </style>
      </div>
    `;
  }

  // Minimal fallback - just an empty div
  return `<div class="mc-fallback" data-component="${componentName}"></div>`;
}

/**
 * Safe component render wrapper
 * Catches errors and returns either error page (dev) or fallback (prod)
 */
function safeRenderComponent(component, componentName, filePath) {
  try {
    // Try tempRender first
    if (typeof component.tempRender === 'function') {
      const startTime = Date.now();
      const result = component.tempRender();
      const renderTime = Date.now() - startTime;

      // Warn about slow renders in development
      if (isDevelopment && renderTime > 100) {
        console.warn(
          new MasterControllerError({
            code: 'MC_ERR_SLOW_RENDER',
            message: `Component rendering slowly on server (${renderTime}ms)`,
            component: componentName,
            file: filePath,
            details: `Render time exceeded 100ms threshold. Consider optimizing this component.`
          }).format()
        );
      }

      return { success: true, html: result, renderTime };
    }

    // Fallback to connectedCallback
    if (typeof component.connectedCallback === 'function') {
      const startTime = Date.now();
      component.connectedCallback();
      const renderTime = Date.now() - startTime;

      // Get the rendered HTML
      const html = component.innerHTML || '';
      return { success: true, html, renderTime };
    }

    // No render method found
    throw new Error('No tempRender() or connectedCallback() method found');

  } catch (error) {
    console.error(
      new MasterControllerError({
        code: 'MC_ERR_COMPONENT_RENDER_FAILED',
        message: `Failed to render component: ${error.message}`,
        component: componentName,
        file: filePath,
        originalError: error
      }).format()
    );

    if (isDevelopment) {
      return {
        success: false,
        html: renderErrorComponent({
          component: componentName,
          error: error.message,
          stack: error.stack,
          file: filePath,
          originalError: error
        }),
        renderTime: 0
      };
    } else {
      // Log error for monitoring
      logProductionError(error, componentName, filePath);

      return {
        success: false,
        html: renderFallback(componentName, { showSkeleton: true }),
        renderTime: 0
      };
    }
  }
}

/**
 * Log production errors for monitoring
 */
function logProductionError(error, component, file) {
  const errorData = {
    timestamp: new Date().toISOString(),
    component,
    file,
    message: error.message,
    stack: error.stack,
    environment: 'production'
  };

  // Log to console (can be captured by monitoring services)
  console.error('[MasterController Production Error]', JSON.stringify(errorData, null, 2));

  // Hook for external logging services (Sentry, LogRocket, etc.)
  if (global.masterControllerErrorHook) {
    try {
      global.masterControllerErrorHook(errorData);
    } catch (hookError) {
      console.error('[MasterController] Error hook failed:', hookError.message);
    }
  }
}

/**
 * Wrap connectedCallback with try-catch
 */
function wrapConnectedCallback(element, componentName, filePath) {
  if (!element || typeof element.connectedCallback !== 'function') {
    return;
  }

  const originalCallback = element.connectedCallback;

  element.connectedCallback = function(...args) {
    try {
      return originalCallback.apply(this, args);
    } catch (error) {
      console.error(
        new MasterControllerError({
          code: 'MC_ERR_COMPONENT_RENDER_FAILED',
          message: `connectedCallback failed: ${error.message}`,
          component: componentName,
          file: filePath,
          originalError: error
        }).format()
      );

      if (isDevelopment) {
        this.innerHTML = renderErrorComponent({
          component: componentName,
          error: error.message,
          stack: error.stack,
          file: filePath,
          originalError: error
        });
      } else {
        logProductionError(error, componentName, filePath);
        this.innerHTML = renderFallback(componentName);
      }
    }
  };
}

/**
 * Check if component has required SSR methods
 */
function validateSSRComponent(componentClass, componentName, filePath) {
  const warnings = [];

  // Check for tempRender method
  if (!componentClass.prototype.tempRender && !componentClass.prototype.connectedCallback) {
    warnings.push(
      new MasterControllerError({
        code: 'MC_ERR_TEMPRENDER_MISSING',
        message: 'Component missing tempRender() method for SSR',
        component: componentName,
        file: filePath,
        details: `Add a tempRender() method to enable server-side rendering:\n\n  tempRender() {\n    return \`<div>Your HTML here</div>\`;\n  }`
      })
    );
  }

  // Warn if only render() exists (client-only)
  if (componentClass.prototype.render && !componentClass.prototype.tempRender) {
    warnings.push(
      new MasterControllerError({
        code: 'MC_ERR_TEMPRENDER_MISSING',
        message: 'Component has render() but no tempRender() - will not SSR',
        component: componentName,
        file: filePath,
        details: 'For SSR, rename render() to tempRender() or add a separate tempRender() method'
      })
    );
  }

  if (warnings.length > 0 && isDevelopment) {
    warnings.forEach(warning => console.warn(warning.format()));
  }

  return warnings.length === 0;
}

module.exports = {
  renderErrorComponent,
  renderFallback,
  safeRenderComponent,
  wrapConnectedCallback,
  validateSSRComponent,
  logProductionError,
  isDevelopment
};
