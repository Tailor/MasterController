/**
 * HydrationMismatch - Detect and report hydration mismatches
 * Compares server-rendered HTML with client-rendered HTML
 * Version: 1.0.0
 */

const isDevelopment = typeof process !== 'undefined'
  ? (process.env.NODE_ENV !== 'production')
  : (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

/**
 * Simple diff algorithm for HTML comparison
 */
function generateDiff(serverHTML, clientHTML) {
  const serverLines = serverHTML.split('\n').map(l => l.trim()).filter(Boolean);
  const clientLines = clientHTML.split('\n').map(l => l.trim()).filter(Boolean);

  const diff = [];
  const maxLines = Math.max(serverLines.length, clientLines.length);

  for (let i = 0; i < maxLines; i++) {
    const serverLine = serverLines[i] || '';
    const clientLine = clientLines[i] || '';

    if (serverLine !== clientLine) {
      diff.push({
        line: i + 1,
        server: serverLine,
        client: clientLine,
        type: !serverLine ? 'added' : !clientLine ? 'removed' : 'modified'
      });
    }
  }

  return diff;
}

/**
 * Format diff for console output
 */
function formatDiffForConsole(diff) {
  let output = '\n';

  diff.slice(0, 10).forEach(change => { // Show first 10 differences
    output += `Line ${change.line}:\n`;

    if (change.type === 'removed') {
      output += `  \x1b[31m- ${change.server}\x1b[0m\n`;
    } else if (change.type === 'added') {
      output += `  \x1b[32m+ ${change.client}\x1b[0m\n`;
    } else {
      output += `  \x1b[31m- ${change.server}\x1b[0m\n`;
      output += `  \x1b[32m+ ${change.client}\x1b[0m\n`;
    }
  });

  if (diff.length > 10) {
    output += `\n... and ${diff.length - 10} more differences\n`;
  }

  return output;
}

/**
 * Compare attributes between two elements
 */
function compareAttributes(serverEl, clientEl) {
  const mismatches = [];

  // Check server attributes
  if (serverEl.attributes) {
    for (const attr of serverEl.attributes) {
      const serverValue = attr.value;
      const clientValue = clientEl.getAttribute(attr.name);

      if (serverValue !== clientValue) {
        mismatches.push({
          attribute: attr.name,
          server: serverValue,
          client: clientValue || '(missing)'
        });
      }
    }
  }

  // Check for client attributes missing on server
  if (clientEl.attributes) {
    for (const attr of clientEl.attributes) {
      if (!serverEl.hasAttribute(attr.name)) {
        mismatches.push({
          attribute: attr.name,
          server: '(missing)',
          client: attr.value
        });
      }
    }
  }

  return mismatches;
}

/**
 * Detect hydration mismatch between server and client HTML
 */
function detectHydrationMismatch(element, componentName, options = {}) {
  if (!element || !element.hasAttribute('data-ssr')) {
    return null; // Not server-rendered
  }

  // Store server HTML before hydration
  const serverHTML = element.innerHTML;

  // Create a clone to test client rendering
  const testElement = element.cloneNode(false);
  testElement.removeAttribute('data-ssr');

  // Simulate client render
  if (typeof element.connectedCallback === 'function') {
    try {
      // Call connectedCallback to trigger client render
      const originalCallback = element.constructor.prototype.connectedCallback;
      if (originalCallback) {
        originalCallback.call(testElement);
      }
    } catch (error) {
      console.warn('[HydrationMismatch] Could not simulate client render:', error);
      return null;
    }
  }

  const clientHTML = testElement.innerHTML;

  // Compare HTML
  if (serverHTML.trim() === clientHTML.trim()) {
    return null; // No mismatch
  }

  // Generate diff
  const diff = generateDiff(serverHTML, clientHTML);

  // Compare attributes
  const attrMismatches = compareAttributes(element, testElement);

  return {
    component: componentName || element.tagName.toLowerCase(),
    serverHTML,
    clientHTML,
    diff,
    attrMismatches,
    element
  };
}

/**
 * Report hydration mismatch to console
 */
function reportHydrationMismatch(mismatch, options = {}) {
  if (!mismatch) return;

  const { component, diff, attrMismatches } = mismatch;

  console.group('\x1b[33m⚠️ MasterController Hydration Mismatch\x1b[0m');
  console.log(`\x1b[36mComponent:\x1b[0m ${component}`);

  // Attribute mismatches
  if (attrMismatches.length > 0) {
    console.log('\n\x1b[33mAttribute Mismatches:\x1b[0m');
    attrMismatches.forEach(attr => {
      console.log(`  ${attr.attribute}:`);
      console.log(`    \x1b[31mServer: ${attr.server}\x1b[0m`);
      console.log(`    \x1b[32mClient: ${attr.client}\x1b[0m`);
    });
  }

  // HTML content mismatches
  if (diff.length > 0) {
    console.log('\n\x1b[33mHTML Diff:\x1b[0m');
    console.log(formatDiffForConsole(diff));
  }

  // Suggestions
  console.log('\n\x1b[36mPossible Causes:\x1b[0m');
  console.log('  1. Component state differs between server and client');
  console.log('  2. Conditional rendering based on client-only APIs (window, navigator, etc.)');
  console.log('  3. Missing or incorrect attributes in client-side render');
  console.log('  4. Random values or timestamps generated during render');
  console.log('  5. Missing data-ssr guard in connectedCallback');

  console.log('\n\x1b[36mSuggestions:\x1b[0m');
  console.log('  • Ensure server and client render with same props/state');
  console.log('  • Use typeof window !== "undefined" checks for browser APIs');
  console.log('  • Avoid random values or Date.now() in render logic');
  console.log('  • Verify data-ssr attribute is present on server-rendered elements');

  console.log('\n\x1b[34mLearn more:\x1b[0m https://mastercontroller.dev/docs/hydration#mismatches');
  console.groupEnd();

  // Log to monitoring service
  if (typeof window !== 'undefined' && window.masterControllerErrorReporter) {
    window.masterControllerErrorReporter({
      type: 'hydration-mismatch',
      component: mismatch.component,
      diffCount: diff.length,
      attrMismatchCount: attrMismatches.length
    });
  }
}

/**
 * Scan all SSR components for hydration mismatches
 */
function scanForHydrationMismatches(options = {}) {
  if (!isDevelopment) return;

  const ssrElements = document.querySelectorAll('[data-ssr]');
  const mismatches = [];

  ssrElements.forEach(element => {
    const componentName = element.tagName.toLowerCase();
    const mismatch = detectHydrationMismatch(element, componentName, options);

    if (mismatch) {
      mismatches.push(mismatch);
      reportHydrationMismatch(mismatch, options);
    }
  });

  if (mismatches.length === 0 && options.verbose) {
    console.log('\x1b[32m✓ No hydration mismatches detected\x1b[0m');
  }

  return mismatches;
}

/**
 * Enable automatic hydration mismatch detection
 */
function enableHydrationMismatchDetection(options = {}) {
  if (!isDevelopment) return;

  // Run check after hydration completes
  if (typeof window !== 'undefined') {
    window.addEventListener('load', () => {
      setTimeout(() => {
        scanForHydrationMismatches(options);
      }, options.delay || 1000);
    });
  }
}

// Auto-enable in development
if (typeof window !== 'undefined' && isDevelopment) {
  enableHydrationMismatchDetection({
    verbose: localStorage.getItem('mc-hydration-debug') === 'true'
  });
}

module.exports = {
  detectHydrationMismatch,
  reportHydrationMismatch,
  scanForHydrationMismatches,
  enableHydrationMismatchDetection,
  generateDiff,
  compareAttributes
};
