// Vanilla Web Components SSR runtime using LinkeDOM
// - Executes connectedCallback() and child component upgrades on the server
// - No Enhance templates, no hardcoded per-component renderers
// - Returns full serialized HTML document string
//
// Usage:
//   const compileWebComponentsHTML = require('./ssr/runtime-ssr.cjs');
//   const htmlOut = await compileWebComponentsHTML(inputHTML);

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const moduleCache = new Map();

// Error handling and monitoring
const { MasterControllerError, findSimilarStrings } = require('../MasterErrorHandler');
const { safeRenderComponent, validateSSRComponent, wrapConnectedCallback } = require('./SSRErrorHandler');
const { monitor } = require('./PerformanceMonitor');
const { logger } = require('../MasterErrorLogger');

// Security - Sanitization and validation
const { sanitizer, sanitizeTemplateHTML, sanitizeProps } = require('../MasterSanitizer');
const { validateEventAttribute } = require('../EventHandlerValidator');

// Performance - Caching and profiling
const { cache } = require('../MasterCache');
const { profiler } = require('../MasterProfiler');

// Track registered custom elements to detect duplicates
const registeredElements = new Map();

// Development mode check
const isDevelopment = process.env.NODE_ENV !== 'production' && process.env.master === 'development';

/**
 * Validate @event attributes in HTML to prevent code injection
 */
function validateEventAttributes(html) {
  if (!html || typeof html !== 'string') return;

  // Find all @event attributes
  const eventAttrRegex = /@([a-z][a-z0-9-]*)\s*=\s*["']([^"']*)["']/gi;
  let match;

  while ((match = eventAttrRegex.exec(html)) !== null) {
    const attrName = `@${match[1]}`;
    const attrValue = match[2];

    // Validate the event handler expression
    const validation = validateEventAttribute(attrName, attrValue, {
      source: 'SSR',
      location: 'runtime-ssr.cjs'
    });

    if (!validation.valid) {
      logger.error({
        code: 'MC_SECURITY_INVALID_EVENT_ATTR',
        message: `Invalid @event attribute detected during SSR`,
        attribute: attrName,
        value: attrValue,
        error: validation.error
      });

      // In development, throw error to prevent bad code
      if (isDevelopment) {
        throw new MasterControllerError({
          code: 'MC_SECURITY_INVALID_EVENT_ATTR',
          message: `Invalid @event attribute: ${attrName}="${attrValue}"`,
          details: validation.error.message,
          suggestions: [
            'Use only this.methodName or this.methodName() syntax',
            'Avoid eval, Function, or other code execution patterns',
            'Check event handler documentation'
          ]
        });
      }
    }
  }
}

module.exports = async function compileWebComponentsHTML(inputHTML, preloadModules = []) {
  // Start performance monitoring
  monitor.startSession();

  try {
    // Defer loading until called (avoid polluting global state early)
    const { parseHTML } = require('linkedom');

    // Create a clean server DOM realm
    const { window, document } = parseHTML('<!doctype html><html><head></head><body></body></html>');

    // Register globals for custom element definitions to bind to this realm
    globalThis.window = window;
    globalThis.document = document;

    // Wrap customElements.define to detect duplicates and validate components
    const originalDefine = window.customElements.define.bind(window.customElements);
    window.customElements.define = function(name, constructor, options) {
      // Check for duplicate registration
      if (registeredElements.has(name)) {
        const existingFile = registeredElements.get(name);
        const currentStack = new Error().stack;

        const error = new MasterControllerError({
          code: 'MC_ERR_DUPLICATE_ELEMENT',
          message: `Duplicate custom element registration attempted`,
          component: name,
          file: existingFile,
          details: `Element "${name}" is already registered. This will cause a browser error.\n\nPossible solutions:\n1. Rename one of the elements\n2. Remove duplicate import\n3. Check if you meant to import the existing component`,
          context: { currentStack }
        });

        if (isDevelopment) {
          console.warn(error.format());
        }

        logger.warn({
          code: error.code,
          message: error.message,
          component: name,
          file: existingFile
        });

        // Don't throw - let browser handle it naturally
        return;
      }

      // Track registration
      const stack = new Error().stack;
      const fileMatch = stack.match(/at .*\((.+?):\d+:\d+\)/);
      const filePath = fileMatch ? fileMatch[1] : 'unknown';
      registeredElements.set(name, filePath);

      // Validate component for SSR
      if (isDevelopment) {
        validateSSRComponent(constructor, name, filePath);
      }

      // Call original define
      return originalDefine(name, constructor, options);
    };

    globalThis.customElements = window.customElements;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.Node = window.Node;
    globalThis.Element = window.Element;
    globalThis.MutationObserver = window.MutationObserver;

    // Minimal stubs used by some components during SSR (noop on server)
    if (typeof globalThis.requestAnimationFrame === 'undefined') {
      globalThis.requestAnimationFrame = (cb) => (typeof cb === 'function' ? cb(0) : undefined);
    }
    if (typeof globalThis.cancelAnimationFrame === 'undefined') {
      globalThis.cancelAnimationFrame = () => {};
    }
    if (typeof globalThis.ResizeObserver === 'undefined') {
      globalThis.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
    }
    if (typeof globalThis.getComputedStyle === 'undefined') {
      globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
    }

    // Create a VM context bound to the LinkeDOM globals
    const context = vm.createContext({
      window,
      document,
      customElements: window.customElements,
      HTMLElement: window.HTMLElement,
      Node: window.Node,
      Element: window.Element,
      MutationObserver: window.MutationObserver,
      console,
      globalThis: window,
      setTimeout: window.setTimeout.bind(window),
      clearTimeout: window.clearTimeout.bind(window),
      setInterval: window.setInterval.bind(window),
      clearInterval: window.clearInterval.bind(window),
    });
    context.__loaderResolve = resolveFile;
    context.__loaderLoad = (p) => loadModuleESMCompatNew(p, context);

    // Resolve ESM file path with basic extension fallback
    function resolveFile(from, spec) {
      const base = spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
      if (!base) return null;
      const candidates = [
        base,
        base + '.js',
        base + '.mjs',
        path.join(base, 'index.js'),
        path.join(base, 'index.mjs'),
      ];
      for (const file of candidates) {
        try { if (fs.existsSync(file)) return file; } catch (_) {}
      }
      return null;
    }

    // ESM compatibility loader that returns exports and preserves imports
    function loadModuleESMCompatNew(absPath, ctx) {
      if (!absPath) return {};
      if (moduleCache.has(absPath)) return moduleCache.get(absPath);
      let code = '';
      try { code = fs.readFileSync(absPath, 'utf8'); }
      catch (e) { console.warn('[SSR] Read failed:', absPath, e && e.message); return {}; }

      // Transform import statements into __requireESM() bindings
      code = code
        // import default from 'spec'
        .replace(/^[ \t]*import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"];?\s*$/mg, 'const $1 = __requireESM("$2").default;')
        // import * as ns from 'spec'
        .replace(/^[ \t]*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"];?\s*$/mg, 'const $1 = __requireESM("$2");')
        // import { a, b as c } from 'spec'
        .replace(/^[ \t]*import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?\s*$/mg, (m, g1, spec) => {
          const mapped = g1.split(',').map(s => s.trim()).filter(Boolean).map(pair => pair.replace(/\s+as\s+/i, ': ')).join(', ');
          return `const { ${mapped} } = __requireESM("${spec}");`;
        })
        // bare import 'spec'
        .replace(/^[ \t]*import\s+['"]([^'"]+)['"];?\s*$/mg, '__requireESM("$1");');

      // Transform export-from
      code = code
        .replace(/^[ \t]*export\s+\*\s+from\s+['"]([^'"]+)['"];?\s*$/mg, (m, spec) => `Object.assign(__exports, __requireESM("${spec}"));`)
        .replace(/^[ \t]*export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?\s*$/mg, (m, names, spec) => {
          return `(function(){ const __m = __requireESM("${spec}"); ${names.split(',').map(s => s.trim()).filter(Boolean).map(pair => {
            if (pair.includes(' as ')) { const [orig, alias] = pair.split(/\s+as\s+/i).map(x=>x.trim()); return `__exports.${alias} = __m.${orig};`; }
            else { return `__exports.${pair} = __m.${pair};`; }
          }).join(' ')} })();`;
        });

      // Transform standalone export { ... } (not from another module)
      // Must match multi-line patterns like: export {\n  Foo,\n  Bar\n};
      code = code.replace(/export\s*\{([^}]+)\}\s*;?/g, (m, names) => {
        // Extract names and attach them to __exports
        const assignments = names.split(',').map(s => s.trim()).filter(Boolean).map(pair => {
          if (pair.includes(' as ')) {
            const [orig, alias] = pair.split(/\s+as\s+/i).map(x=>x.trim());
            return `__exports.${alias} = ${orig};`;
          } else {
            return `__exports.${pair} = ${pair};`;
          }
        }).join(' ');
        return `(function(){ ${assignments} })();`;
      });

      // Transform export default
      code = code.replace(/^[ \t]*export\s+default\s+/mg, '__exports.default = ');

      // Track names of exported declarations to attach to __exports after evaluation
      const exportDeclNames = [];
      (code.match(/^[ \t]*export\s+(?:const|let|var|function|class|async\s+function)\s+([A-Za-z_$][\w$]*)/mg) || []).forEach(line => {
        const name = line.replace(/^[ \t]*export\s+(?:const|let|var|function|class|async\s+function)\s+([A-Za-z_$][\w$]*).*/,'$1');
        exportDeclNames.push(name);
      });

      // Transform export declarations into plain declarations
      // Note: These regexes need to capture and re-emit the full declaration
      code = code
        .replace(/^[ \t]*export\s+(const\s+[A-Za-z_$][\w$]*\s*=)/mg, '$1')
        .replace(/^[ \t]*export\s+(let\s+[A-Za-z_$][\w$]*\s*=)/mg, '$1')
        .replace(/^[ \t]*export\s+(var\s+[A-Za-z_$][\w$]*\s*=)/mg, '$1')
        .replace(/^[ \t]*export\s+(function\s+[A-Za-z_$][\w$]*\s*\()/mg, '$1')
        .replace(/^[ \t]*export\s+(class\s+[A-Za-z_$][\w$]*\s+)/mg, '$1')
        .replace(/^[ \t]*export\s+(async\s+function\s+[A-Za-z_$][\w$]*\s*\()/mg, '$1');

      // Wrap entire module in IIFE to prevent __exports collision between modules
      const wrappedCode = `
        (function() {
          const __exports = {};
          const __modulePath = ${JSON.stringify(absPath)};
          function __requireESM(spec) {
            const resolved = __loaderResolve(__modulePath, spec);
            return __loaderLoad(resolved);
          }

          ${code}

          ${exportDeclNames.map(n => `if (typeof ${n} !== 'undefined') __exports.${n} = ${n};`).join('\n')}
          return __exports;
        })()
      `;

      let result;
      try {
        result = vm.runInContext(wrappedCode, ctx, { filename: absPath });
      } catch (e) {
        const error = new MasterControllerError({
          code: 'MC_ERR_MODULE_LOAD',
          message: `Module execution failed: ${e.message}`,
          file: absPath,
          originalError: e
        });

        if (isDevelopment) {
          console.error(error.format());
        }

        logger.error({
          code: error.code,
          message: error.message,
          file: absPath,
          originalError: e
        });

        result = {};
      }
      moduleCache.set(absPath, result);
      return result;
    }

    // Minimal ESM->CJS execution for side-effect modules (customElements.define)
    function loadModuleESMCompat(absPath, ctx, visited = new Set()) {
      if (!absPath || visited.has(absPath)) return;
      visited.add(absPath);
      let code = '';
      try { code = fs.readFileSync(absPath, 'utf8'); }
      catch (e) { console.warn('[SSR] Read failed:', absPath, e && e.message); return; }

      // Collect relative imports and export-froms, then preload them recursively
      const deps = new Set();
      const reFrom = /^\s*import\s+[^'"]+\s+from\s+['"]([^'"]+)['"];?/mg;
      const reBare = /^\s*import\s+['"]([^'"]+)['"];?/mg;
      const reExportFrom = /^\s*export\s+(?:\*\s+from|{[^}]*}\s+from)\s+['"]([^'"]+)['"];?/mg;
      let m;
      while ((m = reFrom.exec(code))) deps.add(m[1]);
      while ((m = reBare.exec(code))) deps.add(m[1]);
      while ((m = reExportFrom.exec(code))) deps.add(m[1]);

      for (const spec of deps) {
        if (!spec.startsWith('.')) continue; // skip bare specifiers
        const resolved = resolveFile(absPath, spec);
        if (resolved) loadModuleESMCompat(resolved, ctx, visited);
      }

      // Strip import/export syntax; keep side effects (customElements.define)
      // - Convert `export { ... } from '...';` into side-effect import
      code = code
        .replace(/^\s*import\s+[^;]+;?\s*$/mg, '')
        .replace(/^\s*export\s+default\s+/mg, '')
        .replace(/^\s*export\s+{[^}]*}\s+from\s+['"][^'"]+['"];?\s*$/mg, (m) => {
          const spec = m.replace(/^[\s\S]*from\s+['"]([^'"]+)['"].*$/m, '$1');
          return `import '${spec}';`;
        })
        .replace(/^\s*export\s+{[^}]*};?\s*$/mg, '')
        .replace(/^\s*export\s+(class|function)\s+/mg, '$1 ')
        .replace(/^\s*export\s+(const|let|var)\s+/mg, '$1 ')
        .replace(/^\s*export\s+\*\s+from\s+['"]([^'"]+)['"];?\s*$/mg, (m, spec) => {
          return `import '${spec}';`;
        });

      try {
        vm.runInContext(code, ctx, { filename: absPath });
      } catch (e) {
        console.warn('[SSR] Exec failed:', absPath, e && e.message);
      }
    }

    // 1) Load component libraries into this realm so customElements.define runs
    //    (Import shad components first, then any route-specific modules)
    try {
      const root = process.cwd();
      const indexFile = path.resolve(root, 'app/assets/javascripts/shad-web-components/index.js');
      loadModuleESMCompatNew(indexFile, context);
    } catch (e) {
      console.warn('[SSR] Failed to import components index:', e && e.message);
    }

    if (Array.isArray(preloadModules)) {
      for (const mod of preloadModules) {
        if (!mod) continue;
        try {
          const abs = path.isAbsolute(mod) ? mod : path.resolve(process.cwd(), String(mod));
          loadModuleESMCompatNew(abs, context);
        } catch (e) {
          console.warn('[SSR] Failed to preload module:', mod, e && e.message);
        }
      }
    }

    // 2) Extract <head> and <body> content from the input HTML (fallback to full)
    const headMatch = String(inputHTML).match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    const bodyMatch = String(inputHTML).match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const headHTML = headMatch ? headMatch[1] : '';
    const bodyHTML = bodyMatch ? bodyMatch[1] : String(inputHTML);

    // Security: Sanitize HTML before injection (remove dangerous tags/attributes)
    const sanitizedHeadHTML = sanitizeTemplateHTML(headHTML);
    const sanitizedBodyHTML = sanitizeTemplateHTML(bodyHTML);

    // Security: Validate @event attributes
    validateEventAttributes(sanitizedBodyHTML);

    // 3) Inject markup AFTER definitions exist to ensure upgrades + connectedCallback
    document.head.innerHTML = sanitizedHeadHTML;
    document.body.innerHTML = sanitizedBodyHTML;

    // 4) Manually invoke connectedCallback on all custom elements to ensure render() executes
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (el.tagName && el.tagName.includes('-') && typeof el.connectedCallback === 'function') {
        const componentName = el.tagName.toLowerCase();
        const filePath = registeredElements.get(componentName) || 'unknown';

        // Start profiling
        const profile = profiler.startComponentRender(componentName);

        // Check cache first
        const cachedHTML = cache.getCachedRender(componentName, {});
        if (cachedHTML && !isDevelopment) {
          el.innerHTML = cachedHTML;
          profiler.endComponentRender(profile);
          monitor.recordComponent(componentName, 0, filePath);
          continue;
        }

        // Use safe render component wrapper
        const renderStart = Date.now();
        try {
          el.connectedCallback();
          const renderTime = Date.now() - renderStart;

          // Cache the render output (if cacheable)
          if (el.innerHTML && el.innerHTML.length > 0) {
            cache.cacheRender(componentName, {}, el.innerHTML);
          }

          // End profiling
          profiler.endComponentRender(profile);

          // Track performance
          monitor.recordComponent(componentName, renderTime, filePath);

        } catch (e) {
          const renderTime = Date.now() - renderStart;

          // End profiling
          profiler.endComponentRender(profile);

          monitor.recordComponent(componentName, renderTime, filePath);

          const error = new MasterControllerError({
            code: 'MC_ERR_COMPONENT_RENDER_FAILED',
            message: `connectedCallback failed: ${e.message}`,
            component: componentName,
            file: filePath,
            originalError: e
          });

          if (isDevelopment) {
            console.error(error.format());
          }

          logger.error({
            code: error.code,
            message: error.message,
            component: componentName,
            file: filePath,
            originalError: e
          });

          // Replace with error/fallback UI
          if (isDevelopment) {
            el.innerHTML = error.toHTML();
          } else {
            const { renderFallback } = require('./SSRErrorHandler');
            el.innerHTML = renderFallback(componentName);
          }
        }
      }
    }

    // 5) Serialize by walking childNodes (fixes LinkedOM innerHTML caching issue)
    //    When components use appendChild(), innerHTML doesn't update, but childNodes does
    function serializeNode(node) {
      if (node.nodeType === 3) return node.textContent; // Text node
      if (node.nodeType === 8) return `<!--${node.textContent}-->`; // Comment
      if (node.nodeType !== 1) return ''; // Skip other types

      // Element node - serialize opening tag, children, closing tag
      const tag = node.tagName.toLowerCase();
      let html = `<${tag}`;

      // Add attributes
      if (node.attributes) {
        for (const attr of node.attributes) {
          const value = attr.value.replace(/"/g, '&quot;');
          html += ` ${attr.name}="${value}"`;
        }
      }

      // Self-closing tags
      const voidElements = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'];
      if (voidElements.includes(tag)) {
        return html + '>';
      }

      html += '>';

      // Serialize children by walking childNodes (NOT innerHTML)
      if (node.childNodes && node.childNodes.length > 0) {
        for (const child of node.childNodes) {
          html += serializeNode(child);
        }
      }

      html += `</${tag}>`;
      return html;
    }

    // Serialize the full document
    const htmlElement = document.documentElement;
    const finalHTML = '<!DOCTYPE html>' + serializeNode(htmlElement);

    // End performance monitoring and generate report
    const perfReport = monitor.endSession();

    // Log performance metrics
    if (isDevelopment && perfReport) {
      logger.info({
        code: 'MC_INFO_SSR_COMPLETE',
        message: 'SSR completed successfully',
        context: {
          totalTime: perfReport.totalTime,
          componentCount: perfReport.componentCount,
          averageRenderTime: perfReport.averageRenderTime
        }
      });
    }

    return finalHTML;

  } catch (e) {
    const error = new MasterControllerError({
      code: 'MC_ERR_SSR_RUNTIME',
      message: `SSR runtime failed: ${e.message}`,
      originalError: e,
      details: 'The SSR runtime encountered a fatal error. Falling back to original HTML.'
    });

    if (isDevelopment) {
      console.error(error.format());
    }

    logger.error({
      code: error.code,
      message: error.message,
      originalError: e
    });

    // Fallback: return original input
    return String(inputHTML);
  }
};
