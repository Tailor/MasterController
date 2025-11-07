/**
 * MasterErrorLogger - Error logging infrastructure
 * Supports multiple logging backends and monitoring service integration
 * Version: 1.0.0
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
      ...options
    };

    this.backends = [];
    this.errorCount = 0;
    this.sessionId = this._generateSessionId();

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

    const entry = this._formatLogEntry(data, level);

    // Send to all backends
    this.backends.forEach(backend => {
      try {
        backend(entry);
      } catch (error) {
        console.error('[MasterErrorLogger] Backend failed:', error.message);
      }
    });

    this.errorCount++;
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
    return {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      level: LOG_LEVEL_NAMES[level],
      code: data.code || 'UNKNOWN',
      message: data.message || 'No message provided',
      component: data.component || null,
      file: data.file || null,
      line: data.line || null,
      route: data.route || null,
      context: data.context || {},
      stack: data.stack || null,
      originalError: data.originalError ? {
        message: data.originalError.message,
        stack: data.originalError.stack
      } : null,
      environment: process.env.NODE_ENV || 'development',
      nodeVersion: process.version,
      platform: process.platform,
      memory: process.memoryUsage(),
      uptime: process.uptime()
    };
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

    const logFn = entry.level === 'DEBUG' || entry.level === 'INFO' ? console.log :
                  entry.level === 'WARN' ? console.warn : console.error;

    logFn(
      `${color}[${entry.timestamp}] [${entry.level}]${reset} ${entry.code}:`,
      entry.message
    );

    if (entry.component) {
      logFn(`  Component: ${entry.component}`);
    }

    if (entry.file) {
      logFn(`  File: ${entry.file}${entry.line ? `:${entry.line}` : ''}`);
    }

    if (entry.stack && process.env.NODE_ENV !== 'production') {
      logFn(`  Stack: ${entry.stack}`);
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
