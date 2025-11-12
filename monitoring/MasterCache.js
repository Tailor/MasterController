// version 1.0.1
// MasterController Cache System - Runtime Performance Optimization

/**
 * Multi-level cache system for MasterController
 * - Event manifest caching
 * - Component render caching
 * - Template caching
 * - LRU eviction
 * - TTL support
 */

const { logger } = require('../error/MasterErrorLogger');

/**
 * LRU Cache with TTL support
 */
class LRUCache {
  constructor(options = {}) {
    this.maxSize = options.maxSize || 100;
    this.ttl = options.ttl || 3600000; // 1 hour default
    this.cache = new Map();
    this.accessOrder = [];

    // Statistics
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /**
   * Get value from cache
   */
  get(key) {
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Check TTL
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      this.accessOrder = this.accessOrder.filter(k => k !== key);
      this.misses++;
      return null;
    }

    // Update access order (move to end)
    this.accessOrder = this.accessOrder.filter(k => k !== key);
    this.accessOrder.push(key);

    this.hits++;
    return entry.value;
  }

  /**
   * Set value in cache
   */
  set(key, value, ttl = null) {
    // Remove if already exists
    if (this.cache.has(key)) {
      this.accessOrder = this.accessOrder.filter(k => k !== key);
    }

    // Evict if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.accessOrder.shift();
      this.cache.delete(oldestKey);
      this.evictions++;
    }

    // Add new entry
    this.cache.set(key, {
      value,
      expiry: Date.now() + (ttl || this.ttl)
    });

    this.accessOrder.push(key);
  }

  /**
   * Check if key exists
   */
  has(key) {
    return this.get(key) !== null;
  }

  /**
   * Delete entry
   */
  delete(key) {
    this.cache.delete(key);
    this.accessOrder = this.accessOrder.filter(k => k !== key);
  }

  /**
   * Clear cache
   */
  clear() {
    this.cache.clear();
    this.accessOrder = [];
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const total = this.hits + this.misses;
    const hitRate = total > 0 ? (this.hits / total * 100).toFixed(2) : 0;

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: `${hitRate}%`
    };
  }
}

/**
 * MasterController Cache Manager
 */
class MasterCache {
  constructor(options = {}) {
    // Event manifest cache
    this.manifestCache = new LRUCache({
      maxSize: options.manifestCacheSize || 50,
      ttl: options.manifestTTL || 3600000 // 1 hour
    });

    // Component render cache
    this.renderCache = new LRUCache({
      maxSize: options.renderCacheSize || 200,
      ttl: options.renderTTL || 300000 // 5 minutes
    });

    // Template cache
    this.templateCache = new LRUCache({
      maxSize: options.templateCacheSize || 100,
      ttl: options.templateTTL || 3600000 // 1 hour
    });

    // Module cache (for require/import)
    this.moduleCache = new Map();

    // Enabled flag
    this.enabled = options.enabled !== false;
  }

  /**
   * Cache event manifest
   */
  cacheManifest(componentName, manifest) {
    if (!this.enabled) return;

    const key = `manifest:${componentName}`;
    this.manifestCache.set(key, manifest);

    logger.debug({
      code: 'MC_CACHE_MANIFEST',
      message: `Cached manifest for ${componentName}`,
      size: JSON.stringify(manifest).length
    });
  }

  /**
   * Get cached event manifest
   */
  getManifest(componentName) {
    if (!this.enabled) return null;

    const key = `manifest:${componentName}`;
    return this.manifestCache.get(key);
  }

  /**
   * Cache component render output
   */
  cacheRender(componentName, props, html) {
    if (!this.enabled) return;

    // Create cache key from component name and props
    const propsKey = JSON.stringify(props || {});
    const key = `render:${componentName}:${this.hashString(propsKey)}`;

    this.renderCache.set(key, html);

    logger.debug({
      code: 'MC_CACHE_RENDER',
      message: `Cached render for ${componentName}`,
      size: html.length
    });
  }

  /**
   * Get cached component render
   */
  getCachedRender(componentName, props) {
    if (!this.enabled) return null;

    const propsKey = JSON.stringify(props || {});
    const key = `render:${componentName}:${this.hashString(propsKey)}`;

    return this.renderCache.get(key);
  }

  /**
   * Cache template
   */
  cacheTemplate(templatePath, compiled) {
    if (!this.enabled) return;

    const key = `template:${templatePath}`;
    this.templateCache.set(key, compiled);
  }

  /**
   * Get cached template
   */
  getTemplate(templatePath) {
    if (!this.enabled) return null;

    const key = `template:${templatePath}`;
    return this.templateCache.get(key);
  }

  /**
   * Cache module (require/import result)
   */
  cacheModule(modulePath, exports) {
    if (!this.enabled) return;

    this.moduleCache.set(modulePath, exports);
  }

  /**
   * Get cached module
   */
  getModule(modulePath) {
    if (!this.enabled) return null;

    return this.moduleCache.get(modulePath);
  }

  /**
   * Invalidate cache for component
   */
  invalidateComponent(componentName) {
    // Clear manifest
    const manifestKey = `manifest:${componentName}`;
    this.manifestCache.delete(manifestKey);

    // Clear all renders for this component
    // (We'd need to track which keys belong to which components for this)
    // For now, just clear the entire render cache
    this.renderCache.clear();

    logger.info({
      code: 'MC_CACHE_INVALIDATE',
      message: `Cache invalidated for ${componentName}`
    });
  }

  /**
   * Clear all caches
   */
  clearAll() {
    this.manifestCache.clear();
    this.renderCache.clear();
    this.templateCache.clear();
    this.moduleCache.clear();

    logger.info({
      code: 'MC_CACHE_CLEAR',
      message: 'All caches cleared'
    });
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      manifest: this.manifestCache.getStats(),
      render: this.renderCache.getStats(),
      template: this.templateCache.getStats(),
      module: {
        size: this.moduleCache.size
      }
    };
  }

  /**
   * Log cache statistics
   */
  logStats() {
    const stats = this.getStats();

    console.log('\n═══════════════════════════════════════════════════');
    console.log('📊 MasterController Cache Statistics');
    console.log('═══════════════════════════════════════════════════');

    console.log('\nManifest Cache:');
    console.log(`  Size: ${stats.manifest.size}/${stats.manifest.maxSize}`);
    console.log(`  Hits: ${stats.manifest.hits}`);
    console.log(`  Misses: ${stats.manifest.misses}`);
    console.log(`  Hit Rate: ${stats.manifest.hitRate}`);
    console.log(`  Evictions: ${stats.manifest.evictions}`);

    console.log('\nRender Cache:');
    console.log(`  Size: ${stats.render.size}/${stats.render.maxSize}`);
    console.log(`  Hits: ${stats.render.hits}`);
    console.log(`  Misses: ${stats.render.misses}`);
    console.log(`  Hit Rate: ${stats.render.hitRate}`);
    console.log(`  Evictions: ${stats.render.evictions}`);

    console.log('\nTemplate Cache:');
    console.log(`  Size: ${stats.template.size}/${stats.template.maxSize}`);
    console.log(`  Hits: ${stats.template.hits}`);
    console.log(`  Misses: ${stats.template.misses}`);
    console.log(`  Hit Rate: ${stats.template.hitRate}`);
    console.log(`  Evictions: ${stats.template.evictions}`);

    console.log('\nModule Cache:');
    console.log(`  Size: ${stats.module.size}`);

    console.log('═══════════════════════════════════════════════════\n');
  }

  /**
   * Simple string hash function
   */
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36);
  }

  /**
   * Enable cache
   */
  enable() {
    this.enabled = true;
    logger.info({
      code: 'MC_CACHE_ENABLED',
      message: 'Cache enabled'
    });
  }

  /**
   * Disable cache
   */
  disable() {
    this.enabled = false;
    logger.info({
      code: 'MC_CACHE_DISABLED',
      message: 'Cache disabled'
    });
  }
}

// Create singleton instance
const cache = new MasterCache({
  manifestCacheSize: 50,
  renderCacheSize: 200,
  templateCacheSize: 100,
  manifestTTL: 3600000,    // 1 hour
  renderTTL: 300000,        // 5 minutes
  templateTTL: 3600000,     // 1 hour
  enabled: process.env.NODE_ENV === 'production' || process.env.MC_CACHE_ENABLED === 'true'
});

// Auto-cleanup interval (every 5 minutes)
setInterval(() => {
  // Force garbage collection of expired entries
  const stats = cache.getStats();

  logger.debug({
    code: 'MC_CACHE_CLEANUP',
    message: 'Cache cleanup running',
    stats
  });
}, 300000);

module.exports = {
  MasterCache,
  LRUCache,
  cache
};
