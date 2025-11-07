// version 1.0.0
// MasterController Bundle Analyzer - Bundle Size Analysis

const fs = require('fs');
const path = require('path');
const { logger } = require('./MasterErrorLogger');

class MasterBundleAnalyzer {
  constructor(options = {}) {
    this.rootDir = options.rootDir || process.cwd();
    this.outputDir = options.outputDir || path.join(this.rootDir, 'public', '__compiled__');
  }

  /**
   * Analyze bundles
   */
  analyze() {
    const bundles = this.getBundles();
    const report = this.generateReport(bundles);

    this.printReport(report);

    return report;
  }

  /**
   * Get all bundles
   */
  getBundles() {
    const bundles = [];

    if (!fs.existsSync(this.outputDir)) {
      return bundles;
    }

    const files = fs.readdirSync(this.outputDir);

    for (const file of files) {
      const filePath = path.join(this.outputDir, file);
      const stats = fs.statSync(filePath);

      if (stats.isFile() && file.endsWith('.js')) {
        bundles.push({
          name: file,
          size: stats.size,
          gzipSize: Math.round(stats.size * 0.3) // Estimate
        });
      }
    }

    return bundles.sort((a, b) => b.size - a.size);
  }

  /**
   * Generate report
   */
  generateReport(bundles) {
    const totalSize = bundles.reduce((sum, b) => sum + b.size, 0);
    const totalGzip = bundles.reduce((sum, b) => sum + b.gzipSize, 0);

    return {
      bundles,
      totalSize,
      totalGzip,
      bundleCount: bundles.length,
      averageSize: bundles.length > 0 ? totalSize / bundles.length : 0
    };
  }

  /**
   * Print report
   */
  printReport(report) {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('📦 MasterController Bundle Analysis');
    console.log('═══════════════════════════════════════════════════');

    console.log(`\nTotal Bundles: ${report.bundleCount}`);
    console.log(`Total Size: ${(report.totalSize / 1024).toFixed(2)} KB`);
    console.log(`Total Size (Gzip): ${(report.totalGzip / 1024).toFixed(2)} KB`);
    console.log(`Average Bundle Size: ${(report.averageSize / 1024).toFixed(2)} KB`);

    console.log('\nLargest Bundles:');
    report.bundles.slice(0, 10).forEach((bundle, i) => {
      console.log(`  ${i + 1}. ${bundle.name}`);
      console.log(`     Size: ${(bundle.size / 1024).toFixed(2)} KB | Gzip: ${(bundle.gzipSize / 1024).toFixed(2)} KB`);
    });

    console.log('\n💡 Recommendations:');
    if (report.totalSize > 500000) {
      console.log('  ⚠️  Large total bundle size (>500KB)');
      console.log('     - Enable code splitting');
      console.log('     - Use dynamic imports');
      console.log('     - Tree shake unused code');
    }

    const largeBundles = report.bundles.filter(b => b.size > 100000);
    if (largeBundles.length > 0) {
      console.log(`  ⚠️  ${largeBundles.length} bundles exceed 100KB`);
      console.log('     - Break into smaller chunks');
      console.log('     - Lazy load large components');
    }

    console.log('═══════════════════════════════════════════════════\n');
  }
}

module.exports = { MasterBundleAnalyzer };
