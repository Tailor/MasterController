/**
 * MasterErrorLogger - Error logging infrastructure
 * Supports multiple logging backends and monitoring service integration
 * Version: 1.0.1
 */

const fs = require('fs');
const path = require('path');

// Log levels
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4
};

const LOG_LEVEL_NAMES = {
  0: 'DEBUG',
  1: 'INFO',
  2: 'WARN',
  3: 'ERROR',
  4: 'FATAL'
};

class MasterErrorLogger {
  constructor(options = {}) {
    this.options = {
      level: options.level || (process.env.NODE_ENV === 'production' ? LOG_LEVELS.WARN : LOG_LEVELS.DEBUG),
      console: options.console !== false,
      file: options.file || null,
      sampleRate: options.sampleRate || 1.0, // Log 100% by default
      maxFileSize: options.maxFileSize || 10 * 1024 * 1024, // 10MB
      dedupeWindowMs: options.dedupeWindowMs || 5000, // Suppress duplicate errors within 5s
      ...options
    };

    this.backends = [];
    this.errorCount = 0;
    this.sessionId = this._generateSessionId();
    this._recentErrors = new Map(); // code -> { count, firstSeen, lastSeen }

    // Setup default backends
    if (this.options.console) {
      this.backends.push(this._consoleBackend.bind(this));
    }

    if (this.options.file) {
      this.backends.push(this._fileBackend.bind(this));
    }
  }

  /**
   * Add custom logging backend
   */
  addBackend(backend) {
    if (typeof backend === 'function') {
      this.backends.push(backend);
    }
  }

  /**
   * Log an error
   */
  log(data = {}) {
    const level = typeof data.level === 'string'
      ? LOG_LEVELS[data.level.toUpperCase()] || LOG_LEVELS.ERROR
      : data.level || LOG_LEVELS.ERROR;

    // Check log level threshold
    if (level < this.options.level) {
      return;
    }

    // Apply sampling (don't log everything in production)
    if (Math.random() > this.options.sampleRate) {
      return;
    }

    // Deduplicate repeated errors within the window
    const code = data.code || 'UNKNOWN';
    if (level >= LOG_LEVELS.ERROR) {
      const now = Date.now();
      const recent = this._recentErrors.get(code);
      if (recent && (now - recent.firstSeen) < this.options.dedupeWindowMs) {
        recent.count++;
        recent.lastSeen = now;
        return; // Suppress duplicate
      }
      // Flush summary of previous burst if there was one
      if (recent && recent.count > 1) {
        const summary = this._formatLogEntry({
          code: code,
          message: `Suppressed ${recent.count - 1} duplicate entries of ${code} (${recent.lastSeen - recent.firstSeen}ms window)`,
          level: LOG_LEVELS.WARN
        }, LOG_LEVELS.WARN);
        this._dispatch(summary);
      }
      this._recentErrors.set(code, { count: 1, firstSeen: now, lastSeen: now });

      // Prevent unbounded growth — evict stale entries
      if (this._recentErrors.size > 100) {
        for (const [key, val] of this._recentErrors) {
          if ((now - val.lastSeen) > this.options.dedupeWindowMs) {
            this._recentErrors.delete(key);
          }
        }
      }
    }

    const entry = this._formatLogEntry(data, level);
    this._dispatch(entry);
    this.errorCount++;
  }

  /**
   * Dispatch entry to all backends
   */
  _dispatch(entry) {
    this.backends.forEach(backend => {
      try {
        backend(entry);
      } catch (error) {
        // Avoid console methods that can trigger EPIPE recursion
        if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
          try { process.stderr.write(`[MasterErrorLogger] Backend failed: ${error.message}\n`); } catch (_) {}
        }
      }
    });
  }

  /**
   * Convenience methods for different log levels
   */
  debug(data) {
    this.log({ ...data, level: LOG_LEVELS.DEBUG });
  }

  info(data) {
    this.log({ ...data, level: LOG_LEVELS.INFO });
  }

  warn(data) {
    this.log({ ...data, level: LOG_LEVELS.WARN });
  }

  error(data) {
    this.log({ ...data, level: LOG_LEVELS.ERROR });
  }

  fatal(data) {
    this.log({ ...data, level: LOG_LEVELS.FATAL });
  }

  /**
   * Format log entry with metadata
   */
  _formatLogEntry(data, level) {
    const entry = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      level: LOG_LEVEL_NAMES[level],
      code: data.code || 'UNKNOWN',
      message: data.message || 'No message provided'
    };

    // Only include optional fields when they have values
    if (data.component) entry.component = data.component;
    if (data.file) entry.file = data.file;
    if (data.line) entry.line = data.line;
    if (data.route) entry.route = data.route;
    if (data.context && Object.keys(data.context).length > 0) entry.context = data.context;

    // Include stack once — prefer originalError.stack to avoid duplication
    if (data.originalError) {
      entry.stack = data.originalError.stack || data.stack || null;
    } else if (data.stack) {
      entry.stack = data.stack;
    }

    entry.environment = process.env.NODE_ENV || 'development';

    // Only include memory/system info on ERROR and FATAL
    if (level >= LOG_LEVELS.ERROR) {
      entry.memory = process.memoryUsage();
      entry.nodeVersion = process.version;
      entry.platform = process.platform;
      entry.uptime = process.uptime();
    }

    return entry;
  }

  /**
   * Console backend
   */
  _consoleBackend(entry) {
    const levelColors = {
      DEBUG: '\x1b[36m',   // Cyan
      INFO: '\x1b[32m',    // Green
      WARN: '\x1b[33m',    // Yellow
      ERROR: '\x1b[31m',   // Red
      FATAL: '\x1b[35m'    // Magenta
    };

    const color = levelColors[entry.level] || '';
    const reset = '\x1b[0m';

    // Use process.stdout/stderr.write directly to avoid EPIPE recursion
    // through console.log -> broken pipe -> uncaughtException -> logger -> console.log
    const stream = (entry.level === 'DEBUG' || entry.level === 'INFO') ? process.stdout : process.stderr;

    try {
      stream.write(`${color}[${entry.timestamp}] [${entry.level}]${reset} ${entry.code}: ${entry.message}\n`);

      if (entry.component) {
        stream.write(`  Component: ${entry.component}\n`);
      }

      if (entry.file) {
        stream.write(`  File: ${entry.file}${entry.line ? `:${entry.line}` : ''}\n`);
      }

      if (entry.stack && process.env.NODE_ENV !== 'production') {
        stream.write(`  Stack: ${entry.stack}\n`);
      }
    } catch (err) {
      // If the stream is broken (EPIPE), silently drop — do not recurse
    }
  }

  /**
   * File backend
   */
  _fileBackend(entry) {
    if (!this.options.file) return;

    try {
      const logDir = path.dirname(this.options.file);

      // Create log directory if it doesn't exist
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      // Check file size and rotate if needed
      if (fs.existsSync(this.options.file)) {
        const stats = fs.statSync(this.options.file);
        if (stats.size > this.options.maxFileSize) {
          this._rotateLogFile();
        }
      }

      // Append log entry as JSON line
      const logLine = JSON.stringify(entry) + '\n';
      fs.appendFileSync(this.options.file, logLine, 'utf8');

    } catch (error) {
      console.error('[MasterErrorLogger] File logging failed:', error.message);
    }
  }

  /**
   * Rotate log file when it gets too large
   */
  _rotateLogFile() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const ext = path.extname(this.options.file);
      const base = path.basename(this.options.file, ext);
      const dir = path.dirname(this.options.file);
      const rotatedFile = path.join(dir, `${base}-${timestamp}${ext}`);

      fs.renameSync(this.options.file, rotatedFile);

      // Keep only last 5 rotated files
      const files = fs.readdirSync(dir)
        .filter(f => f.startsWith(base) && f !== path.basename(this.options.file))
        .sort()
        .reverse();

      files.slice(5).forEach(f => {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch (_) {}
      });

    } catch (error) {
      console.error('[MasterErrorLogger] Log rotation failed:', error.message);
    }
  }

  /**
   * Generate unique session ID
   */
  _generateSessionId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get logger statistics
   */
  getStats() {
    return {
      sessionId: this.sessionId,
      errorCount: this.errorCount,
      sampleRate: this.options.sampleRate,
      backends: this.backends.length,
      uptime: process.uptime()
    };
  }

  /**
   * Reset error count
   */
  resetStats() {
    this.errorCount = 0;
    this.sessionId = this._generateSessionId();
  }
}

/**
 * Sentry integration helper
 */
function createSentryBackend(sentryInstance) {
  return (entry) => {
    if (entry.level === 'ERROR' || entry.level === 'FATAL') {
      sentryInstance.captureException(new Error(entry.message), {
        level: entry.level.toLowerCase(),
        tags: {
          code: entry.code,
          component: entry.component,
          sessionId: entry.sessionId
        },
        extra: {
          file: entry.file,
          line: entry.line,
          route: entry.route,
          context: entry.context,
          originalError: entry.originalError
        }
      });
    }
  };
}

/**
 * LogRocket integration helper
 */
function createLogRocketBackend(logRocketInstance) {
  return (entry) => {
    if (entry.level === 'ERROR' || entry.level === 'FATAL') {
      logRocketInstance.captureException(new Error(entry.message), {
        tags: {
          code: entry.code,
          component: entry.component
        },
        extra: entry
      });
    }
  };
}

/**
 * Custom webhook backend
 */
function createWebhookBackend(webhookUrl) {
  return async (entry) => {
    try {
      const https = require('https');
      const http = require('http');
      const url = new URL(webhookUrl);
      const client = url.protocol === 'https:' ? https : http;

      const data = JSON.stringify(entry);

      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length
        }
      };

      const req = client.request(options);
      req.write(data);
      req.end();

    } catch (error) {
      console.error('[MasterErrorLogger] Webhook failed:', error.message);
    }
  };
}

// Singleton instance
const logger = new MasterErrorLogger({
  console: true,
  file: process.env.MC_LOG_FILE || path.join(process.cwd(), 'log', 'mastercontroller.log'),
  sampleRate: parseFloat(process.env.MC_LOG_SAMPLE_RATE || '1.0')
});

module.exports = {
  MasterErrorLogger,
  logger,
  LOG_LEVELS,
  createSentryBackend,
  createLogRocketBackend,
  createWebhookBackend
};
