// version 1.0.1
// MasterController Performance Profiler - Component and Request Profiling

/**
 * Performance profiler for MasterController
 * - Component render time tracking
 * - Slow component detection
 * - Request profiling
 * - Performance bottleneck identification
 * - Detailed performance reports
 */

const { logger } = require('../error/MasterErrorLogger');

class MasterProfiler {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.slowThreshold = options.slowThreshold || 100; // 100ms
    this.verySlowThreshold = options.verySlowThreshold || 500; // 500ms

    // Performance data
    this.componentMetrics = new Map();
    this.requestMetrics = [];
    this.currentRequest = null;

    // Marks
    this.marks = new Map();

    // Statistics
    this.totalComponents = 0;
    this.slowComponents = 0;
    this.verySlowComponents = 0;
  }

  /**
   * Start profiling a component render
   */
  startComponentRender(componentName, props = {}) {
    if (!this.enabled) return null;

    const id = `${componentName}-${Date.now()}-${Math.random()}`;

    this.mark(`${id}:start`);

    return {
      id,
      componentName,
      props,
      startTime: Date.now()
    };
  }

  /**
   * End profiling a component render
   */
  endComponentRender(profile) {
    if (!this.enabled || !profile) return;

    this.mark(`${profile.id}:end`);

    const duration = this.measure(
      `${profile.id}:render`,
      `${profile.id}:start`,
      `${profile.id}:end`
    );

    // Store metrics
    if (!this.componentMetrics.has(profile.componentName)) {
      this.componentMetrics.set(profile.componentName, {
        componentName: profile.componentName,
        renders: [],
        totalRenders: 0,
        totalTime: 0,
        avgTime: 0,
        minTime: Infinity,
        maxTime: 0,
        slowRenders: 0,
        verySlowRenders: 0
      });
    }

    const metrics = this.componentMetrics.get(profile.componentName);
    metrics.renders.push({
      duration,
      timestamp: profile.startTime,
      props: profile.props
    });

    metrics.totalRenders++;
    metrics.totalTime += duration;
    metrics.avgTime = metrics.totalTime / metrics.totalRenders;
    metrics.minTime = Math.min(metrics.minTime, duration);
    metrics.maxTime = Math.max(metrics.maxTime, duration);

    if (duration > this.slowThreshold) {
      metrics.slowRenders++;
      this.slowComponents++;

      if (duration > this.verySlowThreshold) {
        metrics.verySlowRenders++;
        this.verySlowComponents++;

        logger.warn({
          code: 'MC_PERF_VERY_SLOW_COMPONENT',
          message: `Very slow component render detected: ${profile.componentName}`,
          duration: `${duration}ms`,
          threshold: `${this.verySlowThreshold}ms`
        });
      }
    }

    this.totalComponents++;

    // Keep only last 100 renders per component
    if (metrics.renders.length > 100) {
      metrics.renders.shift();
    }
  }

  /**
   * Start profiling a request
   */
  startRequest(path, method = 'GET') {
    if (!this.enabled) return null;

    const id = `request-${Date.now()}-${Math.random()}`;

    this.mark(`${id}:start`);

    this.currentRequest = {
      id,
      path,
      method,
      startTime: Date.now(),
      components: []
    };

    return this.currentRequest;
  }

  /**
   * End profiling a request
   */
  endRequest(requestProfile) {
    if (!this.enabled || !requestProfile) return;

    this.mark(`${requestProfile.id}:end`);

    const duration = this.measure(
      `${requestProfile.id}:request`,
      `${requestProfile.id}:start`,
      `${requestProfile.id}:end`
    );

    requestProfile.duration = duration;
    requestProfile.endTime = Date.now();

    this.requestMetrics.push(requestProfile);

    // Keep only last 1000 requests
    if (this.requestMetrics.length > 1000) {
      this.requestMetrics.shift();
    }

    // Log slow requests
    if (duration > 1000) {
      logger.warn({
        code: 'MC_PERF_SLOW_REQUEST',
        message: `Slow request detected: ${requestProfile.method} ${requestProfile.path}`,
        duration: `${duration}ms`
      });
    }

    this.currentRequest = null;
  }

  /**
   * Create a performance mark
   */
  mark(name) {
    if (!this.enabled) return;

    this.marks.set(name, {
      name,
      timestamp: Date.now()
    });
  }

  /**
   * Measure duration between two marks
   */
  measure(name, startMark, endMark) {
    if (!this.enabled) return 0;

    const start = this.marks.get(startMark);
    const end = this.marks.get(endMark);

    if (!start || !end) {
      return 0;
    }

    return end.timestamp - start.timestamp;
  }

  /**
   * Get component performance metrics
   */
  getComponentMetrics(componentName = null) {
    if (componentName) {
      return this.componentMetrics.get(componentName) || null;
    }

    return Array.from(this.componentMetrics.values());
  }

  /**
   * Get request performance metrics
   */
  getRequestMetrics(limit = 100) {
    return this.requestMetrics.slice(-limit);
  }

  /**
   * Get slow components
   */
  getSlowComponents(threshold = null) {
    threshold = threshold || this.slowThreshold;

    return Array.from(this.componentMetrics.values())
      .filter(m => m.avgTime > threshold)
      .sort((a, b) => b.avgTime - a.avgTime);
  }

  /**
   * Get slow requests
   */
  getSlowRequests(threshold = 1000, limit = 100) {
    return this.requestMetrics
      .filter(r => r.duration > threshold)
      .slice(-limit)
      .sort((a, b) => b.duration - a.duration);
  }

  /**
   * Generate performance report
   */
  generateReport() {
    const components = this.getComponentMetrics();
    const slowComponents = this.getSlowComponents();
    const requests = this.getRequestMetrics();
    const slowRequests = this.getSlowRequests();

    // Calculate statistics
    const totalRenderTime = components.reduce((sum, c) => sum + c.totalTime, 0);
    const avgRenderTime = components.length > 0
      ? totalRenderTime / components.reduce((sum, c) => sum + c.totalRenders, 0)
      : 0;

    const totalRequestTime = requests.reduce((sum, r) => sum + r.duration, 0);
    const avgRequestTime = requests.length > 0 ? totalRequestTime / requests.length : 0;

    return {
      summary: {
        totalComponents: this.totalComponents,
        uniqueComponents: components.length,
        slowComponents: this.slowComponents,
        verySlowComponents: this.verySlowComponents,
        totalRequests: requests.length,
        slowRequests: slowRequests.length,
        avgRenderTime: Math.round(avgRenderTime),
        avgRequestTime: Math.round(avgRequestTime)
      },
      components: {
        all: components,
        slow: slowComponents.slice(0, 10)
      },
      requests: {
        recent: requests.slice(-10),
        slow: slowRequests.slice(0, 10)
      }
    };
  }

  /**
   * Print performance report
   */
  printReport() {
    const report = this.generateReport();

    console.log('\n═══════════════════════════════════════════════════');
    console.log('⚡ MasterController Performance Report');
    console.log('═══════════════════════════════════════════════════');

    console.log('\n📊 Summary:');
    console.log(`  Total Component Renders: ${report.summary.totalComponents}`);
    console.log(`  Unique Components: ${report.summary.uniqueComponents}`);
    console.log(`  Slow Components (>${this.slowThreshold}ms): ${report.summary.slowComponents}`);
    console.log(`  Very Slow Components (>${this.verySlowThreshold}ms): ${report.summary.verySlowComponents}`);
    console.log(`  Average Render Time: ${report.summary.avgRenderTime}ms`);
    console.log(`  Total Requests: ${report.summary.totalRequests}`);
    console.log(`  Slow Requests (>1000ms): ${report.summary.slowRequests}`);
    console.log(`  Average Request Time: ${report.summary.avgRequestTime}ms`);

    if (report.components.slow.length > 0) {
      console.log('\n🐌 Slowest Components:');
      report.components.slow.forEach((comp, i) => {
        console.log(`  ${i + 1}. ${comp.componentName}`);
        console.log(`     Avg: ${Math.round(comp.avgTime)}ms | Max: ${Math.round(comp.maxTime)}ms | Renders: ${comp.totalRenders}`);
        console.log(`     Slow Renders: ${comp.slowRenders} | Very Slow: ${comp.verySlowRenders}`);
      });
    }

    if (report.requests.slow.length > 0) {
      console.log('\n🐌 Slowest Requests:');
      report.requests.slow.forEach((req, i) => {
        console.log(`  ${i + 1}. ${req.method} ${req.path}`);
        console.log(`     Duration: ${Math.round(req.duration)}ms`);
      });
    }

    console.log('\n💡 Recommendations:');
    if (report.summary.verySlowComponents > 0) {
      console.log('  ⚠️  Some components are very slow (>500ms)');
      console.log('     - Consider code splitting');
      console.log('     - Optimize expensive operations');
      console.log('     - Use memoization for computed values');
    }

    if (report.summary.slowComponents > 10) {
      console.log('  ⚠️  Many slow components detected');
      console.log('     - Review component implementations');
      console.log('     - Enable render caching');
      console.log('     - Consider lazy loading');
    }

    if (report.summary.slowRequests > 5) {
      console.log('  ⚠️  Multiple slow requests detected');
      console.log('     - Review database queries');
      console.log('     - Add caching');
      console.log('     - Optimize expensive operations');
    }

    console.log('═══════════════════════════════════════════════════\n');

    return report;
  }

  /**
   * Reset profiler
   */
  reset() {
    this.componentMetrics.clear();
    this.requestMetrics = [];
    this.marks.clear();
    this.totalComponents = 0;
    this.slowComponents = 0;
    this.verySlowComponents = 0;
    this.currentRequest = null;

    logger.info({
      code: 'MC_PERF_RESET',
      message: 'Profiler reset'
    });
  }

  /**
   * Enable profiler
   */
  enable() {
    this.enabled = true;
    logger.info({
      code: 'MC_PERF_ENABLED',
      message: 'Profiler enabled'
    });
  }

  /**
   * Disable profiler
   */
  disable() {
    this.enabled = false;
    logger.info({
      code: 'MC_PERF_DISABLED',
      message: 'Profiler disabled'
    });
  }
}

// Create singleton instance
const profiler = new MasterProfiler({
  enabled: process.env.NODE_ENV === 'development' || process.env.MC_PROFILER_ENABLED === 'true',
  slowThreshold: parseInt(process.env.MC_SLOW_THRESHOLD) || 100,
  verySlowThreshold: parseInt(process.env.MC_VERY_SLOW_THRESHOLD) || 500
});

// Auto-print report every 5 minutes in development
if (process.env.NODE_ENV === 'development') {
  setInterval(() => {
    const report = profiler.generateReport();
    if (report.summary.totalComponents > 0) {
      profiler.printReport();
    }
  }, 300000); // 5 minutes
}

module.exports = {
  MasterProfiler,
  profiler
};
