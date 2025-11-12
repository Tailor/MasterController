/**
 * PerformanceMonitor - Track and report SSR performance metrics
 * Version: 1.0.1
 */

const { MasterControllerError } = require('../error/MasterErrorHandler');

const isDevelopment = process.env.NODE_ENV !== 'production' && process.env.master === 'development';

// Performance thresholds (milliseconds)
const THRESHOLDS = {
  SLOW_RENDER: 100,      // Warn if component takes >100ms to render
  VERY_SLOW_RENDER: 500, // Error if component takes >500ms
  TOTAL_SSR: 3000        // Warn if total SSR time exceeds 3s
};

class PerformanceMonitor {
  constructor() {
    this.metrics = {
      totalStartTime: null,
      totalEndTime: null,
      components: new Map(),
      slowComponents: [],
      totalRenderTime: 0,
      componentCount: 0
    };

    this.enabled = isDevelopment || process.env.MC_PERF_MONITOR === 'true';
  }

  /**
   * Start monitoring SSR session
   */
  startSession() {
    if (!this.enabled) return;
    this.metrics.totalStartTime = Date.now();
    this.metrics.components.clear();
    this.metrics.slowComponents = [];
    this.metrics.totalRenderTime = 0;
    this.metrics.componentCount = 0;
  }

  /**
   * Record component render time
   */
  recordComponent(componentName, renderTime, filePath = null) {
    if (!this.enabled) return;

    this.metrics.componentCount++;
    this.metrics.totalRenderTime += renderTime;

    // Store component metrics
    if (!this.metrics.components.has(componentName)) {
      this.metrics.components.set(componentName, {
        name: componentName,
        renderTime,
        renderCount: 1,
        filePath
      });
    } else {
      const existing = this.metrics.components.get(componentName);
      existing.renderTime += renderTime;
      existing.renderCount++;
    }

    // Track slow components
    if (renderTime > THRESHOLDS.SLOW_RENDER) {
      this.metrics.slowComponents.push({
        name: componentName,
        renderTime,
        filePath,
        severity: renderTime > THRESHOLDS.VERY_SLOW_RENDER ? 'error' : 'warning'
      });

      // Warn immediately about slow renders in development
      if (isDevelopment) {
        const severity = renderTime > THRESHOLDS.VERY_SLOW_RENDER ? 'error' : 'warning';
        const message = renderTime > THRESHOLDS.VERY_SLOW_RENDER
          ? `Component rendering VERY slowly (${renderTime}ms > ${THRESHOLDS.VERY_SLOW_RENDER}ms threshold)`
          : `Component rendering slowly (${renderTime}ms > ${THRESHOLDS.SLOW_RENDER}ms threshold)`;

        const error = new MasterControllerError({
          code: 'MC_ERR_SLOW_RENDER',
          message,
          component: componentName,
          file: filePath,
          details: this._getSuggestions(componentName, renderTime)
        });

        if (severity === 'error') {
          console.error(error.format());
        } else {
          console.warn(error.format());
        }
      }
    }
  }

  /**
   * End monitoring session and generate report
   */
  endSession() {
    if (!this.enabled) return null;

    this.metrics.totalEndTime = Date.now();
    const totalTime = this.metrics.totalEndTime - this.metrics.totalStartTime;

    // Warn about slow total SSR time
    if (totalTime > THRESHOLDS.TOTAL_SSR && isDevelopment) {
      console.warn(
        new MasterControllerError({
          code: 'MC_ERR_SLOW_RENDER',
          message: `Total SSR time exceeded threshold (${totalTime}ms > ${THRESHOLDS.TOTAL_SSR}ms)`,
          details: `Rendered ${this.metrics.componentCount} components. Consider optimizing slow components or using lazy loading.`
        }).format()
      );
    }

    const report = this._generateReport(totalTime);

    // Print report in development
    if (isDevelopment) {
      this._printReport(report);
    }

    return report;
  }

  /**
   * Generate performance report
   */
  _generateReport(totalTime) {
    // Sort components by render time
    const sortedComponents = Array.from(this.metrics.components.values())
      .sort((a, b) => b.renderTime - a.renderTime);

    return {
      totalTime,
      componentCount: this.metrics.componentCount,
      averageRenderTime: this.metrics.componentCount > 0
        ? Math.round(this.metrics.totalRenderTime / this.metrics.componentCount)
        : 0,
      slowComponents: this.metrics.slowComponents,
      topComponents: sortedComponents.slice(0, 10),
      summary: {
        fast: sortedComponents.filter(c => c.renderTime <= THRESHOLDS.SLOW_RENDER).length,
        slow: sortedComponents.filter(c => c.renderTime > THRESHOLDS.SLOW_RENDER && c.renderTime <= THRESHOLDS.VERY_SLOW_RENDER).length,
        verySlow: sortedComponents.filter(c => c.renderTime > THRESHOLDS.VERY_SLOW_RENDER).length
      }
    };
  }

  /**
   * Print formatted performance report
   */
  _printReport(report) {
    console.log('\n' + '═'.repeat(80));
    console.log('🚀 MasterController SSR Performance Report');
    console.log('═'.repeat(80));
    console.log(`Total SSR Time: ${report.totalTime}ms`);
    console.log(`Components Rendered: ${report.componentCount}`);
    console.log(`Average Render Time: ${report.averageRenderTime}ms`);
    console.log(`\nPerformance Summary:`);
    console.log(`  ✅ Fast (<${THRESHOLDS.SLOW_RENDER}ms): ${report.summary.fast}`);
    console.log(`  ⚠️  Slow (${THRESHOLDS.SLOW_RENDER}-${THRESHOLDS.VERY_SLOW_RENDER}ms): ${report.summary.slow}`);
    console.log(`  ❌ Very Slow (>${THRESHOLDS.VERY_SLOW_RENDER}ms): ${report.summary.verySlow}`);

    if (report.topComponents.length > 0) {
      console.log(`\nTop ${Math.min(10, report.topComponents.length)} Slowest Components:`);
      report.topComponents.forEach((comp, index) => {
        const icon = comp.renderTime > THRESHOLDS.VERY_SLOW_RENDER ? '❌' :
                     comp.renderTime > THRESHOLDS.SLOW_RENDER ? '⚠️' : '✅';
        console.log(`  ${icon} ${index + 1}. ${comp.name}: ${comp.renderTime}ms (${comp.renderCount} render${comp.renderCount > 1 ? 's' : ''})`);
      });
    }

    console.log('═'.repeat(80) + '\n');
  }

  /**
   * Get optimization suggestions for slow components
   */
  _getSuggestions(componentName, renderTime) {
    const suggestions = [
      'Reduce the amount of data rendered initially',
      'Use pagination or virtual scrolling for large lists',
      'Move expensive calculations to data fetching layer',
      'Consider lazy loading or code splitting',
      'Cache computed values',
      'Optimize database queries if data-fetching is involved'
    ];

    let details = `\nOptimization Suggestions:\n`;
    suggestions.forEach((suggestion, index) => {
      details += `${index + 1}. ${suggestion}\n`;
    });

    return details;
  }

  /**
   * Get current metrics snapshot
   */
  getMetrics() {
    return {
      ...this.metrics,
      currentTime: Date.now() - (this.metrics.totalStartTime || Date.now())
    };
  }

  /**
   * Reset metrics
   */
  reset() {
    this.metrics = {
      totalStartTime: null,
      totalEndTime: null,
      components: new Map(),
      slowComponents: [],
      totalRenderTime: 0,
      componentCount: 0
    };
  }
}

// Singleton instance
const monitor = new PerformanceMonitor();

module.exports = {
  PerformanceMonitor,
  monitor,
  THRESHOLDS
};
