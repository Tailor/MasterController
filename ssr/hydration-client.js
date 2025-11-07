/**
 * MasterController Client-Side Hydration Runtime
 * Handles error boundaries and hydration mismatch detection
 * Version: 2.0.0
 */

// Import error boundary
import { ErrorBoundary } from './ErrorBoundary.js';

// Import hydration mismatch detection
const isDevelopment = window.location.hostname === 'localhost' ||
                     window.location.hostname === '127.0.0.1';

if (isDevelopment && typeof require !== 'undefined') {
  try {
    const { enableHydrationMismatchDetection } = require('./HydrationMismatch.js');
    enableHydrationMismatchDetection({
      verbose: localStorage.getItem('mc-hydration-debug') === 'true',
      delay: 1000
    });
  } catch (e) {
    console.warn('[MasterController] Could not load hydration mismatch detection:', e.message);
  }
}

// Auto-wrap app root with error boundary if not already wrapped
document.addEventListener('DOMContentLoaded', () => {
  const appRoot = document.querySelector('root-layout') || document.body;

  // Check if already wrapped
  if (!appRoot.closest('error-boundary')) {
    // Create error boundary wrapper
    const boundary = document.createElement('error-boundary');

    // Set development mode
    if (isDevelopment) {
      boundary.setAttribute('dev-mode', '');
    }

    // Configure custom error handler
    boundary.onError = (errorInfo) => {
      console.error('[App Error]', errorInfo);

      // Send to monitoring service if configured
      if (window.masterControllerErrorReporter) {
        window.masterControllerErrorReporter(errorInfo);
      }
    };

    // Wrap content
    const parent = appRoot.parentNode;
    parent.insertBefore(boundary, appRoot);
    boundary.appendChild(appRoot);
  }
});

// Global error reporter hook
window.masterControllerErrorReporter = window.masterControllerErrorReporter || function(errorData) {
  console.log('[MasterController] Error reported:', errorData);

  // Example: Send to your monitoring service
  // fetch('/api/errors', {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify(errorData)
  // });

  // Example: Send to Sentry
  // if (window.Sentry) {
  //   Sentry.captureException(new Error(errorData.message), {
  //     extra: errorData
  //   });
  // }
};

// Log successful hydration
if (isDevelopment) {
  window.addEventListener('load', () => {
    const ssrElements = document.querySelectorAll('[data-ssr]');
    if (ssrElements.length > 0) {
      console.log(
        `%c✓ MasterController Hydration Complete`,
        'color: #10b981; font-weight: bold; font-size: 14px;'
      );
      console.log(`  ${ssrElements.length} server-rendered components hydrated`);
    }
  });
}

// Export for manual use
export {
  ErrorBoundary
};
