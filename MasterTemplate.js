// version 0.0.4
// https://github.com/WebReflection/backtick-template
// https://stackoverflow.com/questions/29182244/convert-a-string-to-a-template-string

// Security - Template injection prevention
const { escapeHTML } = require('./MasterSanitizer');
const { logger } = require('./MasterErrorLogger');

var replace = ''.replace;

var ca = /[&<>'"]/g;
var es = /&(?:amp|#38|lt|#60|gt|#62|apos|#39|quot|#34);/g;

var esca = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&#39;',
  '"': '&quot;'
};
var unes = {
  '&amp;': '&',
  '&#38;': '&',
  '&lt;': '<',
  '&#60;': '<',
  '&gt;': '>',
  '&#62;': '>',
  '&apos;': "'",
  '&#39;': "'",
  '&quot;': '"',
  '&#34;': '"'
};

class MasterTemplate{

  _ = {};
  $ = 0;


  /*! (C) 2017-2018 Andrea Giammarchi - MIT Style License */
  htmlBuilder( fn, $str, $object) {
    'use strict';

    try{
        // reset cache every 32M
        if (33554432 < this.$) {
          this._ = {};
          this.$ = 0;
        }
        var
          hasTransformer = typeof fn === 'function',
          str = hasTransformer ? $str : fn,
          object = hasTransformer ? $object : $str,
          _ = this._,
          known = _.hasOwnProperty(str);

        // Security: Validate template for dangerous patterns
        if (!known) {
          this.validateTemplate(str);
        }

        var parsed = known ? _[str] : (_[str] = this.parse(str)),
          chunks = parsed.chunks,
          values = parsed.values,
          strings
        ;
        // add str length only if not known
        if (!known)
          this.$ += str.length;
        if (hasTransformer) {
          str = 'function' + (Math.random() * 1e5 | 0);
          strings = [
            str,
            'with(this)return ' + str + '([' + chunks + ']' + (
              values.length ? (',' + values.join(',')) : ''
            ) + ')'
          ];
        } else {
          strings = chunks.slice(0, 1);
          for (var i = 1, length = chunks.length; i < length; i++)
            strings.push(values[i - 1], chunks[i]);
          strings = ['with(this)return ' + strings.join('+')];
        }

        return Function.apply(null, strings).apply(
          object,
          hasTransformer ? [fn] : []
        );
    }
    catch(err){
      console.log("error", err);
    }
}

parse(str) {
var
  stringify = JSON.stringify,
  open = 0, close = 0, counter = 0,
  i = 0, length = str.length,
  chunks = i < length ? [] : ['""'],
  values = []
;
while (i < length) {
  open = str.indexOf('${', i);
  if (-1 < open) {
    chunks.push(stringify(str.slice(i, open)));
    open += 2;
    close = open;
    counter = 1;
    while (close < length) {
      switch (str.charAt(close++)) {
        case '}': --counter; break;
        case '{': ++counter; break;
      }
      if (counter < 1) {
        values.push('(' + str.slice(open, close - 1) + ')');
        break;
      }
    }
    i = close;
  } else {
    chunks.push(stringify(str.slice(i)));
    i = length;
  }
}
if (chunks.length === values.length)
  chunks.push('""');
return {chunks: chunks, values: values};
};
    
    escape(es) {
        return replace.call(es, ca, this.pe);
    }

    unescape(un) {
    return replace.call(un, es, this.cape);
    }

    pe(m) {
    return esca[m];
    }

    cape(m) {
    return unes[m];
    }

    // ==================== Security Methods ====================

    /**
     * Validate template for dangerous patterns
     * Prevents template injection attacks
     */
    validateTemplate(template) {
        if (!template || typeof template !== 'string') {
            return;
        }

        const isDevelopment = process.env.NODE_ENV !== 'production' && process.env.master === 'development';

        // Dangerous patterns in templates
        const dangerousPatterns = [
            { pattern: /\$\{.*__proto__/gi, name: 'Prototype pollution' },
            { pattern: /\$\{.*constructor.*\(/gi, name: 'Constructor access' },
            { pattern: /\$\{.*\beval\s*\(/gi, name: 'eval() usage' },
            { pattern: /\$\{.*Function\s*\(/gi, name: 'Function constructor' },
            { pattern: /\$\{.*require\s*\(/gi, name: 'require() usage' },
            { pattern: /\$\{.*import\s*\(/gi, name: 'import() usage' },
            { pattern: /\$\{.*process\./gi, name: 'Process access' },
            { pattern: /\$\{.*global\./gi, name: 'Global object access' },
            { pattern: /\$\{.*\bfs\./gi, name: 'File system access' },
            { pattern: /\$\{.*child_process/gi, name: 'Child process access' }
        ];

        for (const { pattern, name } of dangerousPatterns) {
            if (pattern.test(template)) {
                logger.error({
                    code: 'MC_SECURITY_TEMPLATE_INJECTION',
                    message: `Dangerous template pattern detected: ${name}`,
                    pattern: pattern.toString(),
                    template: template.substring(0, 200) // Log first 200 chars only
                });

                if (isDevelopment) {
                    throw new Error(`[MasterController Security] Template injection attempt detected: ${name}\nPattern: ${pattern}`);
                }

                // In production, sanitize by removing the dangerous expression
                template = template.replace(pattern, '${/* REMOVED: Security risk */}');
            }
        }

        return template;
    }

    /**
     * Sanitize template variables before rendering
     * Call this on user-provided data
     */
    sanitizeVariable(value) {
        if (value === null || value === undefined) {
            return '';
        }

        if (typeof value === 'string') {
            return escapeHTML(value);
        }

        if (typeof value === 'object') {
            // Prevent prototype pollution
            if (value.__proto__ || value.constructor) {
                logger.warn({
                    code: 'MC_SECURITY_OBJECT_POLLUTION',
                    message: 'Attempted to pass object with prototype/constructor to template'
                });
                return '[Object]';
            }

            // Safely stringify
            try {
                return JSON.stringify(value);
            } catch (e) {
                return '[Object]';
            }
        }

        return String(value);
    }
}

module.exports = MasterTemplate;