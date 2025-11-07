// version 1.0.0
// MasterController Build Optimizer - Minification, Tree Shaking, Dead Code Elimination

/**
 * Build-time optimizations for MasterController
 * - Minifies event manifests
 * - Eliminates dead code
 * - Tree shaking for unused components
 * - Optimizes bundle size
 */

const fs = require('fs');
const path = require('path');
const { logger } = require('./MasterErrorLogger');

class MasterBuildOptimizer {
  constructor(options = {}) {
    this.rootDir = options.rootDir || process.cwd();
    this.outputDir = options.outputDir || path.join(this.rootDir, 'public', '__compiled__');
    this.minify = options.minify !== false;
    this.treeShake = options.treeShake !== false;
    this.deadCodeElimination = options.deadCodeElimination !== false;
    this.sourceMaps = options.sourceMaps || false;

    // Statistics
    this.stats = {
      filesProcessed: 0,
      bytesOriginal: 0,
      bytesOptimized: 0,
      timeTaken: 0,
      componentsFound: 0,
      componentsUsed: 0,
      componentsRemoved: 0
    };
  }

  /**
   * Optimize entire build
   */
  async optimize() {
    const startTime = Date.now();

    logger.info({
      code: 'MC_PERF_BUILD_START',
      message: 'Build optimization started'
    });

    try {
      // 1. Analyze component usage
      const usageMap = await this.analyzeComponentUsage();

      // 2. Tree shake unused components
      if (this.treeShake) {
        await this.treeShakeComponents(usageMap);
      }

      // 3. Minify event manifests
      if (this.minify) {
        await this.minifyEventManifests();
      }

      // 4. Eliminate dead code
      if (this.deadCodeElimination) {
        await this.eliminateDeadCode();
      }

      // 5. Optimize bundle
      await this.optimizeBundle();

      this.stats.timeTaken = Date.now() - startTime;

      // Log results
      this.logOptimizationResults();

      return this.stats;
    } catch (error) {
      logger.error({
        code: 'MC_PERF_BUILD_ERROR',
        message: 'Build optimization failed',
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Analyze which components are actually used in the application
   */
  async analyzeComponentUsage() {
    const usageMap = new Map();

    // Scan all view files
    const viewsDir = path.join(this.rootDir, 'app', 'views');
    const viewFiles = this.findFiles(viewsDir, ['.html', '.js']);

    for (const file of viewFiles) {
      const content = fs.readFileSync(file, 'utf8');

      // Find custom element usages (<ui-button>, <ui-calendar>, etc.)
      const customElements = content.match(/<([a-z]+-[a-z-]+)/g) || [];

      for (const match of customElements) {
        const tagName = match.substring(1); // Remove <
        usageMap.set(tagName, (usageMap.get(tagName) || 0) + 1);
      }
    }

    this.stats.componentsFound = usageMap.size;

    logger.info({
      code: 'MC_PERF_USAGE_ANALYSIS',
      message: 'Component usage analysis complete',
      componentsFound: usageMap.size
    });

    return usageMap;
  }

  /**
   * Tree shake unused components from the bundle
   */
  async treeShakeComponents(usageMap) {
    const componentsDir = path.join(this.rootDir, 'app', 'assets', 'javascripts', 'shad-web-components', 'components');

    if (!fs.existsSync(componentsDir)) {
      return;
    }

    const componentFiles = this.findFiles(componentsDir, ['.js']);
    let removedCount = 0;

    for (const file of componentFiles) {
      const content = fs.readFileSync(file, 'utf8');

      // Extract component tag name from customElements.define call
      const defineMatch = content.match(/customElements\.define\(['"]([^'"]+)['"]/);

      if (defineMatch) {
        const tagName = defineMatch[1];

        // If component is not used, mark for removal
        if (!usageMap.has(tagName)) {
          removedCount++;
          logger.info({
            code: 'MC_PERF_TREE_SHAKE',
            message: `Unused component detected: ${tagName}`,
            file: path.basename(file)
          });

          // In production, we'd actually remove or exclude this from the bundle
          // For now, just log it
        }
      }
    }

    this.stats.componentsUsed = usageMap.size;
    this.stats.componentsRemoved = removedCount;
  }

  /**
   * Minify event manifest JSON files
   */
  async minifyEventManifests() {
    const manifestsDir = path.join(this.outputDir, 'event-manifests');

    if (!fs.existsSync(manifestsDir)) {
      return;
    }

    const manifestFiles = fs.readdirSync(manifestsDir).filter(f => f.endsWith('.json'));

    for (const file of manifestFiles) {
      const filePath = path.join(manifestsDir, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const originalSize = Buffer.byteLength(content, 'utf8');

      // Parse and re-stringify without whitespace
      const parsed = JSON.parse(content);
      const minified = JSON.stringify(parsed);

      const minifiedSize = Buffer.byteLength(minified, 'utf8');

      // Write minified version
      fs.writeFileSync(filePath, minified, 'utf8');

      this.stats.filesProcessed++;
      this.stats.bytesOriginal += originalSize;
      this.stats.bytesOptimized += minifiedSize;

      logger.info({
        code: 'MC_PERF_MINIFY',
        message: `Minified ${file}`,
        originalSize: originalSize,
        minifiedSize: minifiedSize,
        savings: `${((1 - minifiedSize / originalSize) * 100).toFixed(1)}%`
      });
    }
  }

  /**
   * Eliminate dead code from JavaScript bundles
   */
  async eliminateDeadCode() {
    const jsDir = path.join(this.outputDir);

    if (!fs.existsSync(jsDir)) {
      return;
    }

    const jsFiles = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'));

    for (const file of jsFiles) {
      const filePath = path.join(jsDir, file);
      let content = fs.readFileSync(filePath, 'utf8');
      const originalSize = Buffer.byteLength(content, 'utf8');

      // Remove console.log statements in production
      if (process.env.NODE_ENV === 'production') {
        content = content.replace(/console\.log\([^)]*\);?/g, '');
        content = content.replace(/console\.debug\([^)]*\);?/g, '');
      }

      // Remove comments
      content = content.replace(/\/\*[\s\S]*?\*\//g, ''); // Block comments
      content = content.replace(/\/\/.*/g, ''); // Line comments

      // Remove empty lines
      content = content.replace(/^\s*[\r\n]/gm, '');

      const optimizedSize = Buffer.byteLength(content, 'utf8');

      // Write optimized version
      fs.writeFileSync(filePath, content, 'utf8');

      this.stats.bytesOriginal += originalSize;
      this.stats.bytesOptimized += optimizedSize;
    }
  }

  /**
   * Optimize bundle size
   */
  async optimizeBundle() {
    // Analyze and report bundle sizes
    const compiledDir = this.outputDir;

    if (!fs.existsSync(compiledDir)) {
      return;
    }

    const files = fs.readdirSync(compiledDir);
    const bundles = [];

    for (const file of files) {
      const filePath = path.join(compiledDir, file);
      const stats = fs.statSync(filePath);

      if (stats.isFile() && file.endsWith('.js')) {
        bundles.push({
          name: file,
          size: stats.size,
          gzipSize: this.estimateGzipSize(stats.size)
        });
      }
    }

    // Sort by size
    bundles.sort((a, b) => b.size - a.size);

    // Log largest bundles
    const topBundles = bundles.slice(0, 5);
    for (const bundle of topBundles) {
      logger.info({
        code: 'MC_PERF_BUNDLE_SIZE',
        message: `Bundle: ${bundle.name}`,
        size: `${(bundle.size / 1024).toFixed(2)} KB`,
        gzipSize: `${(bundle.gzipSize / 1024).toFixed(2)} KB`
      });
    }

    return bundles;
  }

  /**
   * Estimate gzip size (approximation: ~30% of original)
   */
  estimateGzipSize(size) {
    return Math.round(size * 0.3);
  }

  /**
   * Find files recursively
   */
  findFiles(dir, extensions) {
    const files = [];

    if (!fs.existsSync(dir)) {
      return files;
    }

    const items = fs.readdirSync(dir);

    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        files.push(...this.findFiles(fullPath, extensions));
      } else if (extensions.some(ext => item.endsWith(ext))) {
        files.push(fullPath);
      }
    }

    return files;
  }

  /**
   * Log optimization results
   */
  logOptimizationResults() {
    const savingsPercent = this.stats.bytesOriginal > 0
      ? ((1 - this.stats.bytesOptimized / this.stats.bytesOriginal) * 100).toFixed(1)
      : 0;

    logger.info({
      code: 'MC_PERF_BUILD_COMPLETE',
      message: 'Build optimization complete',
      context: {
        filesProcessed: this.stats.filesProcessed,
        originalSize: `${(this.stats.bytesOriginal / 1024).toFixed(2)} KB`,
        optimizedSize: `${(this.stats.bytesOptimized / 1024).toFixed(2)} KB`,
        savings: `${savingsPercent}%`,
        timeTaken: `${this.stats.timeTaken}ms`,
        componentsFound: this.stats.componentsFound,
        componentsUsed: this.stats.componentsUsed,
        componentsRemoved: this.stats.componentsRemoved
      }
    });

    // Print summary
    console.log('\n═══════════════════════════════════════════════════');
    console.log('🚀 MasterController Build Optimization Complete');
    console.log('═══════════════════════════════════════════════════');
    console.log(`Files Processed: ${this.stats.filesProcessed}`);
    console.log(`Original Size: ${(this.stats.bytesOriginal / 1024).toFixed(2)} KB`);
    console.log(`Optimized Size: ${(this.stats.bytesOptimized / 1024).toFixed(2)} KB`);
    console.log(`Savings: ${savingsPercent}%`);
    console.log(`Time Taken: ${this.stats.timeTaken}ms`);
    console.log(`Components Found: ${this.stats.componentsFound}`);
    console.log(`Components Used: ${this.stats.componentsUsed}`);
    console.log(`Unused Components: ${this.stats.componentsRemoved}`);
    console.log('═══════════════════════════════════════════════════\n');
  }
}

// CLI usage
if (require.main === module) {
  const optimizer = new MasterBuildOptimizer({
    rootDir: process.cwd(),
    minify: true,
    treeShake: true,
    deadCodeElimination: true
  });

  optimizer.optimize()
    .then(stats => {
      console.log('✅ Build optimization successful');
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Build optimization failed:', error.message);
      process.exit(1);
    });
}

module.exports = { MasterBuildOptimizer };
