/**
 * PrometheusExporter - Production-grade metrics for Prometheus monitoring
 * Version: 1.0.0
 *
 * Provides a /_metrics endpoint compatible with Prometheus scraping format.
 * Tracks HTTP request metrics, system metrics, and custom application metrics.
 *
 * Usage in MasterControl pipeline:
 *
 *   const { prometheusExporter } = require('./monitoring/PrometheusExporter');
 *
 *   // Register the middleware
 *   master.pipeline.use(prometheusExporter.middleware());
 *
 * Metrics endpoint: GET /_metrics
 * Returns: Prometheus text format metrics
 *
 * Optional: Install prom-client for advanced features
 *   npm install prom-client --save-optional
 */

const os = require('os');
const { logger } = require('../error/MasterErrorLogger');

class PrometheusExporter {
  constructor(options = {}) {
    this.options = {
      endpoint: options.endpoint || '/_metrics',
      prefix: options.prefix || 'mastercontroller_',
      collectDefaultMetrics: options.collectDefaultMetrics !== false,
      ...options
    };

    this.startTime = Date.now();

    // HTTP request metrics
    this.httpRequestsTotal = {}; // Counter by method, path, status
    this.httpRequestDuration = {}; // Histogram by method, path
    this.httpRequestsInFlight = 0; // Current active requests
    this.httpRequestSizeBytes = {}; // Histogram of request sizes
    this.httpResponseSizeBytes = {}; // Histogram of response sizes

    // Custom metrics storage
    this.customMetrics = new Map();

    // Try to load prom-client if available (optional peer dependency)
    try {
      this.promClient = require('prom-client');
      this._setupPromClient();
    } catch (e) {
      // prom-client not installed, use simple implementation
      this.promClient = null;
      logger.info({
        code: 'MC_PROMETHEUS_SIMPLE_MODE',
        message: 'Running Prometheus exporter in simple mode (install prom-client for advanced features)'
      });
    }
  }

  /**
   * Setup prom-client if available
   */
  _setupPromClient() {
    const { Registry, Counter, Histogram, Gauge } = this.promClient;
    this.register = new Registry();

    // HTTP request counter
    this.httpRequestCounter = new Counter({
      name: `${this.options.prefix}http_requests_total`,
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'path', 'status'],
      registers: [this.register]
    });

    // HTTP request duration histogram
    this.httpDurationHistogram = new Histogram({
      name: `${this.options.prefix}http_request_duration_seconds`,
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'path', 'status'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10],
      registers: [this.register]
    });

    // Active requests gauge
    this.activeRequestsGauge = new Gauge({
      name: `${this.options.prefix}http_requests_in_flight`,
      help: 'Number of HTTP requests currently being processed',
      registers: [this.register]
    });

    // Request size histogram
    this.requestSizeHistogram = new Histogram({
      name: `${this.options.prefix}http_request_size_bytes`,
      help: 'HTTP request size in bytes',
      labelNames: ['method', 'path'],
      buckets: [100, 1000, 10000, 100000, 1000000, 10000000],
      registers: [this.register]
    });

    // Response size histogram
    this.responseSizeHistogram = new Histogram({
      name: `${this.options.prefix}http_response_size_bytes`,
      help: 'HTTP response size in bytes',
      labelNames: ['method', 'path', 'status'],
      buckets: [100, 1000, 10000, 100000, 1000000, 10000000],
      registers: [this.register]
    });

    // Collect default system metrics if enabled
    if (this.options.collectDefaultMetrics) {
      this.promClient.collectDefaultMetrics({
        register: this.register,
        prefix: this.options.prefix
      });
    }
  }

  /**
   * Middleware for MasterPipeline - tracks all HTTP requests
   */
  middleware() {
    const self = this;

    return async (ctx, next) => {
      const requestPath = ctx.request.url.split('?')[0];

      // Handle metrics endpoint
      if (requestPath === self.options.endpoint) {
        return await self._handleMetricsEndpoint(ctx);
      }

      // Track request metrics
      const startTime = Date.now();
      self.httpRequestsInFlight++;

      if (self.activeRequestsGauge) {
        self.activeRequestsGauge.inc();
      }

      // Get request size
      const requestSize = parseInt(ctx.request.headers['content-length'] || 0);

      try {
        // Continue pipeline
        await next();

        // Record metrics on success
        const duration = (Date.now() - startTime) / 1000; // Convert to seconds
        const method = ctx.request.method;
        const status = ctx.response.statusCode || 200;
        const responseSize = parseInt(ctx.response.getHeader('content-length') || 0);

        self._recordRequest(method, requestPath, status, duration, requestSize, responseSize);

      } catch (error) {
        // Record error metrics
        const duration = (Date.now() - startTime) / 1000;
        const method = ctx.request.method;
        const status = 500;

        self._recordRequest(method, requestPath, status, duration, requestSize, 0);

        throw error; // Re-throw for error handling middleware

      } finally {
        self.httpRequestsInFlight--;

        if (self.activeRequestsGauge) {
          self.activeRequestsGauge.dec();
        }
      }
    };
  }

  /**
   * Record HTTP request metrics
   */
  _recordRequest(method, path, status, duration, requestSize, responseSize) {
    // Normalize path (remove IDs, etc.) for better grouping
    const normalizedPath = this._normalizePath(path);

    if (this.promClient) {
      // Use prom-client
      this.httpRequestCounter.inc({ method, path: normalizedPath, status });
      this.httpDurationHistogram.observe({ method, path: normalizedPath, status }, duration);

      if (requestSize > 0) {
        this.requestSizeHistogram.observe({ method, path: normalizedPath }, requestSize);
      }

      if (responseSize > 0) {
        this.responseSizeHistogram.observe({ method, path: normalizedPath, status }, responseSize);
      }

    } else {
      // Simple implementation
      const key = `${method}:${normalizedPath}:${status}`;

      if (!this.httpRequestsTotal[key]) {
        this.httpRequestsTotal[key] = { count: 0, totalDuration: 0 };
      }

      this.httpRequestsTotal[key].count++;
      this.httpRequestsTotal[key].totalDuration += duration;

      if (!this.httpRequestDuration[key]) {
        this.httpRequestDuration[key] = [];
      }
      this.httpRequestDuration[key].push(duration);

      // Keep only last 1000 durations per endpoint to prevent memory leak
      if (this.httpRequestDuration[key].length > 1000) {
        this.httpRequestDuration[key].shift();
      }
    }
  }

  /**
   * Normalize path for metrics (remove IDs, hashes, etc.)
   */
  _normalizePath(path) {
    return path
      .replace(/\/[0-9a-f]{24}$/i, '/:id') // MongoDB ObjectId
      .replace(/\/[0-9]+$/, '/:id') // Numeric IDs
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '/:uuid') // UUIDs
      .replace(/\?.*$/, ''); // Remove query params
  }

  /**
   * Handle /_metrics endpoint
   */
  async _handleMetricsEndpoint(ctx) {
    try {
      logger.debug({
        code: 'MC_METRICS_SCRAPE',
        message: 'Metrics scrape requested',
        ip: ctx.request.connection.remoteAddress
      });

      let metricsText;

      if (this.promClient) {
        // Use prom-client to generate metrics
        metricsText = await this.register.metrics();
      } else {
        // Simple implementation
        metricsText = this._generateSimpleMetrics();
      }

      // Set response headers
      ctx.response.setHeader('Content-Type', 'text/plain; version=0.0.4');
      ctx.response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      ctx.response.statusCode = 200;
      ctx.response.end(metricsText);

    } catch (error) {
      logger.error({
        code: 'MC_METRICS_ERROR',
        message: 'Metrics generation failed',
        error: error.message,
        stack: error.stack
      });

      ctx.response.statusCode = 500;
      ctx.response.setHeader('Content-Type', 'text/plain');
      ctx.response.end('# Error generating metrics\n');
    }
  }

  /**
   * Generate simple metrics text (when prom-client not available)
   */
  _generateSimpleMetrics() {
    const lines = [];
    const now = Date.now();

    // Add header
    lines.push('# MasterController Metrics (Simple Mode)');
    lines.push('# Install prom-client for advanced metrics');
    lines.push('');

    // Process uptime
    const uptime = Math.floor((now - this.startTime) / 1000);
    lines.push('# HELP process_uptime_seconds Process uptime in seconds');
    lines.push('# TYPE process_uptime_seconds gauge');
    lines.push(`process_uptime_seconds ${uptime}`);
    lines.push('');

    // HTTP requests total
    lines.push('# HELP mastercontroller_http_requests_total Total number of HTTP requests');
    lines.push('# TYPE mastercontroller_http_requests_total counter');
    for (const [key, data] of Object.entries(this.httpRequestsTotal)) {
      const [method, path, status] = key.split(':');
      lines.push(`mastercontroller_http_requests_total{method="${method}",path="${path}",status="${status}"} ${data.count}`);
    }
    lines.push('');

    // HTTP request duration (avg)
    lines.push('# HELP mastercontroller_http_request_duration_seconds_avg Average HTTP request duration');
    lines.push('# TYPE mastercontroller_http_request_duration_seconds_avg gauge');
    for (const [key, data] of Object.entries(this.httpRequestsTotal)) {
      const [method, path, status] = key.split(':');
      const avgDuration = data.totalDuration / data.count;
      lines.push(`mastercontroller_http_request_duration_seconds_avg{method="${method}",path="${path}",status="${status}"} ${avgDuration.toFixed(6)}`);
    }
    lines.push('');

    // Active requests
    lines.push('# HELP mastercontroller_http_requests_in_flight Number of HTTP requests in flight');
    lines.push('# TYPE mastercontroller_http_requests_in_flight gauge');
    lines.push(`mastercontroller_http_requests_in_flight ${this.httpRequestsInFlight}`);
    lines.push('');

    // Memory metrics
    const memory = process.memoryUsage();
    lines.push('# HELP process_memory_heap_used_bytes Heap memory used in bytes');
    lines.push('# TYPE process_memory_heap_used_bytes gauge');
    lines.push(`process_memory_heap_used_bytes ${memory.heapUsed}`);
    lines.push('');

    lines.push('# HELP process_memory_heap_total_bytes Total heap memory in bytes');
    lines.push('# TYPE process_memory_heap_total_bytes gauge');
    lines.push(`process_memory_heap_total_bytes ${memory.heapTotal}`);
    lines.push('');

    lines.push('# HELP process_memory_rss_bytes Resident set size in bytes');
    lines.push('# TYPE process_memory_rss_bytes gauge');
    lines.push(`process_memory_rss_bytes ${memory.rss}`);
    lines.push('');

    // CPU metrics
    const cpuUsage = process.cpuUsage();
    lines.push('# HELP process_cpu_user_microseconds User CPU time in microseconds');
    lines.push('# TYPE process_cpu_user_microseconds counter');
    lines.push(`process_cpu_user_microseconds ${cpuUsage.user}`);
    lines.push('');

    lines.push('# HELP process_cpu_system_microseconds System CPU time in microseconds');
    lines.push('# TYPE process_cpu_system_microseconds counter');
    lines.push(`process_cpu_system_microseconds ${cpuUsage.system}`);
    lines.push('');

    // Custom metrics
    for (const [name, metric] of this.customMetrics) {
      lines.push(`# HELP ${this.options.prefix}${name} ${metric.help || 'Custom metric'}`);
      lines.push(`# TYPE ${this.options.prefix}${name} ${metric.type || 'gauge'}`);

      if (metric.labels) {
        for (const [labelKey, value] of Object.entries(metric.labels)) {
          const labelStr = Object.entries(labelKey)
            .map(([k, v]) => `${k}="${v}"`)
            .join(',');
          lines.push(`${this.options.prefix}${name}{${labelStr}} ${value}`);
        }
      } else {
        lines.push(`${this.options.prefix}${name} ${metric.value}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Register custom metric
   */
  registerMetric(name, type, help, value, labels = null) {
    this.customMetrics.set(name, { type, help, value, labels });
  }

  /**
   * Update custom metric value
   */
  updateMetric(name, value, labels = null) {
    const metric = this.customMetrics.get(name);
    if (metric) {
      if (labels) {
        if (!metric.labels) {
          metric.labels = {};
        }
        metric.labels[JSON.stringify(labels)] = value;
      } else {
        metric.value = value;
      }
    }
  }

  /**
   * Increment counter metric
   */
  incrementCounter(name, labels = null) {
    const metric = this.customMetrics.get(name);
    if (metric && metric.type === 'counter') {
      if (labels) {
        const key = JSON.stringify(labels);
        if (!metric.labels) {
          metric.labels = {};
        }
        metric.labels[key] = (metric.labels[key] || 0) + 1;
      } else {
        metric.value = (metric.value || 0) + 1;
      }
    }
  }
}

// Singleton instance
const prometheusExporter = new PrometheusExporter({
  endpoint: '/_metrics',
  collectDefaultMetrics: true
});

module.exports = {
  PrometheusExporter,
  prometheusExporter
};
