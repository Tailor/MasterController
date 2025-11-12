// version 1.0.1
// MasterController Memory Monitor - Memory Leak Detection

/**
 * Memory monitor for detecting memory leaks
 * - Heap usage tracking
 * - Memory leak detection
 * - Garbage collection monitoring
 * - Memory alerts
 */

const { logger } = require('../error/MasterErrorLogger');

class MasterMemoryMonitor {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.checkInterval = options.checkInterval || 30000; // 30 seconds
    this.leakThreshold = options.leakThreshold || 50; // 50MB growth
    this.alertThreshold = options.alertThreshold || 500; // 500MB

    this.snapshots = [];
    this.maxSnapshots = 100;
    this.intervalId = null;
  }

  /**
   * Start monitoring
   */
  start() {
    if (!this.enabled || this.intervalId) return;

    this.takeSnapshot();

    this.intervalId = setInterval(() => {
      this.takeSnapshot();
      this.checkForLeaks();
    }, this.checkInterval);

    logger.info({
      code: 'MC_MEMORY_MONITOR_START',
      message: 'Memory monitoring started',
      interval: `${this.checkInterval}ms`
    });
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;

      logger.info({
        code: 'MC_MEMORY_MONITOR_STOP',
        message: 'Memory monitoring stopped'
      });
    }
  }

  /**
   * Take memory snapshot
   */
  takeSnapshot() {
    const usage = process.memoryUsage();

    const snapshot = {
      timestamp: Date.now(),
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      rss: usage.rss
    };

    this.snapshots.push(snapshot);

    // Keep only last N snapshots
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift();
    }

    // Alert if memory usage is high
    const heapUsedMB = usage.heapUsed / 1024 / 1024;
    if (heapUsedMB > this.alertThreshold) {
      logger.warn({
        code: 'MC_MEMORY_HIGH',
        message: 'High memory usage detected',
        heapUsed: `${heapUsedMB.toFixed(2)} MB`,
        threshold: `${this.alertThreshold} MB`
      });
    }

    return snapshot;
  }

  /**
   * Check for memory leaks
   */
  checkForLeaks() {
    if (this.snapshots.length < 10) return;

    // Compare first 5 and last 5 snapshots
    const oldSnapshots = this.snapshots.slice(0, 5);
    const newSnapshots = this.snapshots.slice(-5);

    const oldAvg = oldSnapshots.reduce((sum, s) => sum + s.heapUsed, 0) / oldSnapshots.length;
    const newAvg = newSnapshots.reduce((sum, s) => sum + s.heapUsed, 0) / newSnapshots.length;

    const growthBytes = newAvg - oldAvg;
    const growthMB = growthBytes / 1024 / 1024;

    if (growthMB > this.leakThreshold) {
      logger.warn({
        code: 'MC_MEMORY_LEAK_DETECTED',
        message: 'Potential memory leak detected',
        growth: `${growthMB.toFixed(2)} MB`,
        oldAvg: `${(oldAvg / 1024 / 1024).toFixed(2)} MB`,
        newAvg: `${(newAvg / 1024 / 1024).toFixed(2)} MB`,
        suggestion: 'Review component lifecycle and event listener cleanup'
      });
    }
  }

  /**
   * Get current memory usage
   */
  getCurrentUsage() {
    const usage = process.memoryUsage();

    return {
      heapUsed: `${(usage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
      heapTotal: `${(usage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
      external: `${(usage.external / 1024 / 1024).toFixed(2)} MB`,
      rss: `${(usage.rss / 1024 / 1024).toFixed(2)} MB`
    };
  }

  /**
   * Print memory report
   */
  printReport() {
    if (this.snapshots.length === 0) {
      console.log('No memory snapshots available');
      return;
    }

    const current = this.snapshots[this.snapshots.length - 1];
    const first = this.snapshots[0];

    const growth = current.heapUsed - first.heapUsed;
    const growthPercent = (growth / first.heapUsed * 100).toFixed(2);

    console.log('\n═══════════════════════════════════════════════════');
    console.log('💾 MasterController Memory Report');
    console.log('═══════════════════════════════════════════════════');

    console.log('\nCurrent Usage:');
    console.log(`  Heap Used: ${(current.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Heap Total: ${(current.heapTotal / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  External: ${(current.external / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  RSS: ${(current.rss / 1024 / 1024).toFixed(2)} MB`);

    console.log('\nMemory Growth:');
    console.log(`  Initial: ${(first.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Current: ${(current.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Growth: ${(growth / 1024 / 1024).toFixed(2)} MB (${growthPercent}%)`);

    console.log(`\nSnapshots: ${this.snapshots.length}`);
    console.log(`Duration: ${((current.timestamp - first.timestamp) / 1000 / 60).toFixed(2)} minutes`);

    console.log('═══════════════════════════════════════════════════\n');
  }
}

// Create singleton
const memoryMonitor = new MasterMemoryMonitor({
  enabled: process.env.MC_MEMORY_MONITOR === 'true',
  checkInterval: 30000,
  leakThreshold: 50,
  alertThreshold: 500
});

// Auto-start in development
if (process.env.NODE_ENV === 'development') {
  memoryMonitor.start();
}

module.exports = { MasterMemoryMonitor, memoryMonitor };
