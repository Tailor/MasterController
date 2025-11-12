/**
 * ErrorBoundary - Production error boundary system for Web Components
 * Catches component errors without crashing entire application
 * Version: 1.0.0
 */

/**
 * ErrorBoundary Web Component
 * Usage:
 *   <error-boundary>
 *     <my-component></my-component>
 *   </error-boundary>
 */
class ErrorBoundary extends HTMLElement {
  constructor() {
    super();
    this._hasError = false;
    this._errorInfo = null;
    this._originalContent = null;
  }

  connectedCallback() {
    // Store original content
    this._originalContent = this.innerHTML;

    // Catch errors from child components
    this.addEventListener('error', this._handleError.bind(this), true);

    // Also catch unhandled promise rejections in child components
    window.addEventListener('unhandledrejection', this._handleRejection.bind(this));

    // Wrap all child custom elements with error catching
    this._wrapChildComponents();
  }

  disconnectedCallback() {
    this.removeEventListener('error', this._handleError, true);
    window.removeEventListener('unhandledrejection', this._handleRejection);
  }

  /**
   * Wrap child component lifecycle methods with error handling
   */
  _wrapChildComponents() {
    const customElements = this.querySelectorAll('*');

    customElements.forEach(el => {
      if (!el.tagName.includes('-')) return;

      // Wrap connectedCallback
      if (el.connectedCallback && !el._errorBoundaryWrapped) {
        const originalConnected = el.connectedCallback.bind(el);
        el.connectedCallback = (...args) => {
          try {
            return originalConnected(...args);
          } catch (error) {
            this._catchComponentError(error, el);
          }
        };
        el._errorBoundaryWrapped = true;
      }

      // Wrap attributeChangedCallback
      if (el.attributeChangedCallback && !el._errorBoundaryAttrWrapped) {
        const originalAttrChanged = el.attributeChangedCallback.bind(el);
        el.attributeChangedCallback = (...args) => {
          try {
            return originalAttrChanged(...args);
          } catch (error) {
            this._catchComponentError(error, el);
          }
        };
        el._errorBoundaryAttrWrapped = true;
      }
    });
  }

  /**
   * Handle error events
   */
  _handleError(event) {
    // Only handle errors from child elements
    if (!this.contains(event.target)) return;

    event.preventDefault();
    event.stopPropagation();

    this._catchComponentError(event.error || new Error('Unknown error'), event.target);
  }

  /**
   * Handle unhandled promise rejections
   */
  _handleRejection(event) {
    // Check if rejection came from a component within this boundary
    if (event.reason && event.reason.component) {
      const component = this.querySelector(event.reason.component);
      if (component) {
        this._catchComponentError(event.reason, component);
      }
    }
  }

  /**
   * Catch and handle component errors
   */
  _catchComponentError(error, component) {
    if (this._hasError) return; // Already in error state

    this._hasError = true;
    this._errorInfo = {
      error,
      component: component ? component.tagName.toLowerCase() : 'unknown',
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
      url: window.location.href
    };

    // Log error
    this._logError();

    // Show fallback UI
    this._showFallbackUI();

    // Call custom error handler if provided
    if (typeof this.onError === 'function') {
      try {
        this.onError(this._errorInfo);
      } catch (handlerError) {
        console.error('[ErrorBoundary] onError handler failed:', handlerError);
      }
    }

    // Dispatch custom event for external monitoring
    this.dispatchEvent(new CustomEvent('error-boundary-catch', {
      bubbles: true,
      detail: this._errorInfo
    }));
  }

  /**
   * Log error to console and monitoring services
   */
  _logError() {
    console.error('[ErrorBoundary] Caught error:', this._errorInfo);

    // Send to monitoring service if configured
    if (window.masterControllerErrorReporter) {
      try {
        window.masterControllerErrorReporter({
          type: 'error-boundary',
          ...this._errorInfo
        });
      } catch (reporterError) {
        console.error('[ErrorBoundary] Error reporter failed:', reporterError);
      }
    }

    // Send to Sentry if available
    if (window.Sentry) {
      window.Sentry.captureException(this._errorInfo.error, {
        tags: {
          component: this._errorInfo.component,
          errorBoundary: true
        },
        extra: this._errorInfo
      });
    }
  }

  /**
   * Show fallback UI
   */
  _showFallbackUI() {
    const fallbackTemplate = this.getAttribute('fallback-template');
    const customMessage = this.getAttribute('error-message');

    if (fallbackTemplate) {
      // Use custom template
      const template = document.querySelector(fallbackTemplate);
      if (template) {
        this.innerHTML = template.innerHTML;
        return;
      }
    }

    // Default fallback UI
    const isDevelopment = this.hasAttribute('dev-mode');

    this.innerHTML = `
      <div class="error-boundary-fallback" style="
        padding: 20px;
        margin: 10px 0;
        background: ${isDevelopment ? '#fee' : '#f9fafb'};
        border: 2px solid ${isDevelopment ? '#f87171' : '#d1d5db'};
        border-radius: 8px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      ">
        <div style="display: flex; align-items: start; gap: 12px;">
          <div style="font-size: 24px;">${isDevelopment ? '❌' : '⚠️'}</div>
          <div style="flex: 1;">
            <h3 style="margin: 0 0 8px 0; color: ${isDevelopment ? '#dc2626' : '#374151'}; font-size: 18px; font-weight: 600;">
              ${customMessage || 'Something went wrong'}
            </h3>
            <p style="margin: 0 0 12px 0; color: #6b7280; font-size: 14px;">
              ${isDevelopment
                ? `Component "${this._errorInfo.component}" encountered an error.`
                : 'We\'ve been notified and are working on it.'
              }
            </p>
            ${isDevelopment ? `
              <details style="margin-top: 12px;">
                <summary style="cursor: pointer; color: #3b82f6; font-weight: 600; font-size: 14px;">
                  View Error Details
                </summary>
                <pre style="
                  margin-top: 12px;
                  padding: 12px;
                  background: #1f2937;
                  color: #f3f4f6;
                  border-radius: 4px;
                  font-size: 12px;
                  overflow-x: auto;
                  font-family: 'Courier New', monospace;
                ">${this.escapeHtml(this._errorInfo.error.stack || this._errorInfo.error.message)}</pre>
              </details>
            ` : ''}
            <button
              onclick="this.closest('.error-boundary-fallback').parentElement.dispatchEvent(new CustomEvent('error-boundary-retry', { bubbles: true }))"
              style="
                margin-top: 12px;
                padding: 8px 16px;
                background: #3b82f6;
                color: white;
                border: none;
                border-radius: 6px;
                font-weight: 600;
                font-size: 14px;
                cursor: pointer;
              "
              onmouseover="this.style.background='#2563eb'"
              onmouseout="this.style.background='#3b82f6'"
            >
              Try Again
            </button>
          </div>
        </div>
      </div>
    `;

    // Handle retry button
    this.addEventListener('error-boundary-retry', this._handleRetry.bind(this), { once: true });
  }

  /**
   * Handle retry
   */
  _handleRetry() {
    this._hasError = false;
    this._errorInfo = null;
    this.innerHTML = this._originalContent;

    // Re-wrap child components
    this._wrapChildComponents();

    // Dispatch retry event
    this.dispatchEvent(new CustomEvent('error-boundary-retried', {
      bubbles: true
    }));
  }

  /**
   * Escape HTML for safe rendering
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

  /**
   * Public API: Reset error state
   */
  reset() {
    this._handleRetry();
  }

  /**
   * Public API: Get error info
   */
  getErrorInfo() {
    return this._errorInfo;
  }

  /**
   * Public API: Check if has error
   */
  hasError() {
    return this._hasError;
  }
}

// Register the error boundary component
if (!customElements.get('error-boundary')) {
  customElements.define('error-boundary', ErrorBoundary);
}

// Global error handler setup
if (typeof window !== 'undefined') {
  // Catch uncaught errors globally
  window.addEventListener('error', (event) => {
    console.error('[MasterController] Uncaught error:', event.error);

    // Try to find nearest error boundary
    if (event.target instanceof HTMLElement) {
      let boundary = event.target.closest('error-boundary');
      if (boundary) {
        // Error will be handled by the boundary
        return;
      }
    }

    // No boundary found - log to monitoring service
    if (window.masterControllerErrorReporter) {
      window.masterControllerErrorReporter({
        type: 'uncaught-error',
        error: event.error,
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno
      });
    }
  });

  // Catch unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[MasterController] Unhandled rejection:', event.reason);

    if (window.masterControllerErrorReporter) {
      window.masterControllerErrorReporter({
        type: 'unhandled-rejection',
        reason: event.reason
      });
    }
  });
}

export { ErrorBoundary };
