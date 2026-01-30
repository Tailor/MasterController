// version 2.0 - FIXED: Instance-level filters, async support, multiple filters
const { logger } = require('./error/MasterErrorLogger');

// HTTP Status Code Constants
const HTTP_STATUS = {
	OK: 200,
	BAD_REQUEST: 400,
	FORBIDDEN: 403,
	INTERNAL_ERROR: 500
};

class MasterActionFilters {

	// Default filter timeout (5 seconds)
	static DEFAULT_FILTER_TIMEOUT = 5000;

	// Lazy-load master to avoid circular dependency (Google-style Singleton pattern)
	static get _master() {
		if (!MasterActionFilters.__masterCache) {
			MasterActionFilters.__masterCache = require('./MasterControl');
		}
		return MasterActionFilters.__masterCache;
	}

	constructor() {
		// FIXED: Instance-level storage instead of module-level
		// Each controller gets its own filter arrays
		this._beforeActionFilters = [];
		this._afterActionFilters = [];

		// Configurable timeout per controller instance
		this._filterTimeout = MasterActionFilters.DEFAULT_FILTER_TIMEOUT;
	}

	/**
	 * Normalize action name by removing whitespace
	 * @private
	 * @param {string} action - Action name
	 * @returns {string} Normalized action name
	 */
	_normalizeAction(action) {
		return action.replace(/\s/g, '');
	}

	/**
	 * Find matching filters for an action
	 * @private
	 * @param {Array} filters - Filter array to search
	 * @param {Object} obj - Controller instance
	 * @param {Object} request - Request object
	 * @returns {Array} Matching filters
	 */
	_findMatchingFilters(filters, obj, request) {
		if (!filters || filters.length === 0) {
			return [];
		}

		const requestAction = this._normalizeAction(request.toAction);

		return filters.filter(filter => {
			// Skip disabled filters
			if (filter.enabled === false) {
				return false;
			}

			// Check namespace matches
			if (filter.namespace !== obj.__namespace) {
				return false;
			}

			// Check if any action in filter's actionList matches
			return filter.actionList.some(actionName => {
				const normalizedAction = this._normalizeAction(actionName);
				return normalizedAction === requestAction;
			});
		});
	}

	/**
	 * Send standardized error response for filter failures
	 * @private
	 * @param {Object} request - Request object
	 * @param {number} statusCode - HTTP status code
	 * @param {string} errorCode - Error code for client
	 * @returns {void}
	 */
	_sendFilterErrorResponse(request, statusCode, errorCode) {
		const res = request.response;
		if (res && !res._headerSent && !res.headersSent) {
			const errorResponse = {
				error: true,
				statusCode,
				code: errorCode,
				message: 'Filter execution failed',
				timestamp: new Date().toISOString(),
				path: request.pathName,
				method: request.request?.method
			};

			res.writeHead(statusCode, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(errorResponse));
		}
	}

	/**
	 * Validate filter registration parameters
	 * @private
	 * @param {string|Array<string>} actionlist - Action names to filter
	 * @param {Function} func - Filter callback function
	 * @param {string} filterType - 'before' or 'after' for logging
	 * @returns {boolean} True if valid, false otherwise
	 */
	_validateFilterParams(actionlist, func, filterType) {
		// Validate callback function
		if (typeof func !== 'function') {
			logger.warn({
				code: 'MC_FILTER_INVALID_CALLBACK',
				message: `${filterType}Action callback is not a function`,
				namespace: this.__namespace
			});
			return false;
		}

		// Validate actionlist exists
		if (!actionlist || (Array.isArray(actionlist) && actionlist.length === 0)) {
			logger.warn({
				code: 'MC_FILTER_EMPTY_ACTIONLIST',
				message: `${filterType}Action actionlist is empty or undefined`,
				namespace: this.__namespace
			});
			return false;
		}

		// Validate actionlist contains valid strings
		const actions = Array.isArray(actionlist) ? actionlist : [actionlist];
		for (const action of actions) {
			if (typeof action !== 'string' || action.trim() === '') {
				logger.warn({
					code: 'MC_FILTER_INVALID_ACTION',
					message: `${filterType}Action actionlist contains invalid action name`,
					namespace: this.__namespace,
					action: action
				});
				return false;
			}
		}

		// Validate namespace exists
		if (!this.__namespace) {
			logger.warn({
				code: 'MC_FILTER_MISSING_NAMESPACE',
				message: `${filterType}Action called but controller has no __namespace`,
			});
			return false;
		}

		return true;
	}

	/**
	 * Register a before action filter
	 * Filters execute before the specified actions in priority order (higher priority first)
	 * @param {string|Array<string>} actionlist - Action name(s) to filter
	 * @param {Function} func - Filter callback function(request)
	 * @param {Object} [options={}] - Filter options
	 * @param {number} [options.priority=0] - Filter priority (higher executes first)
	 * @param {string} [options.name] - Filter name for debugging
	 * @returns {void}
	 * @example
	 * this.beforeAction('index', function(request) {
	 *   if (!this.isAuthenticated()) {
	 *     this.redirectTo('/login');
	 *     return;
	 *   }
	 *   this.next(); // Continue to action
	 * });
	 * @example
	 * // With priority (higher priority runs first)
	 * this.beforeAction(['create', 'update'], function(request) {
	 *   this.loadUser();
	 *   this.next();
	 * }, { priority: 10, name: 'loadUser' });
	 */
	beforeAction(actionlist, func, options = {}){
		if (!this._validateFilterParams(actionlist, func, 'before')) {
			return;
		}

		// FIXED: Push to array with metadata and priority
		this._beforeActionFilters.push({
			namespace: this.__namespace,
			actionList: Array.isArray(actionlist) ? actionlist : [actionlist],
			callBack: func,
			that: this,
			priority: options.priority || 0,
			name: options.name || func.name || 'anonymous',
			enabled: true,
			registeredAt: new Date().toISOString()
		});

		// Sort filters by priority (higher priority first)
		this._beforeActionFilters.sort((a, b) => b.priority - a.priority);
	}

	/**
	 * Register an after action filter
	 * Filters execute after the specified actions complete in priority order
	 * @param {string|Array<string>} actionlist - Action name(s) to filter
	 * @param {Function} func - Filter callback function(request)
	 * @param {Object} [options={}] - Filter options
	 * @param {number} [options.priority=0] - Filter priority (higher executes first)
	 * @param {string} [options.name] - Filter name for debugging
	 * @returns {void}
	 * @example
	 * this.afterAction('index', function(request) {
	 *   logger.info({ action: 'index', userId: this.currentUser.id });
	 * });
	 * @example
	 * // With priority
	 * this.afterAction(['create', 'update'], function(request) {
	 *   this.clearCache();
	 * }, { priority: 5, name: 'clearCache' });
	 */
	afterAction(actionlist, func, options = {}){
		if (!this._validateFilterParams(actionlist, func, 'after')) {
			return;
		}

		// FIXED: Push to array with metadata and priority
		this._afterActionFilters.push({
			namespace: this.__namespace,
			actionList: Array.isArray(actionlist) ? actionlist : [actionlist],
			callBack: func,
			that: this,
			priority: options.priority || 0,
			name: options.name || func.name || 'anonymous',
			enabled: true,
			registeredAt: new Date().toISOString()
		});

		// Sort filters by priority (higher priority first)
		this._afterActionFilters.sort((a, b) => b.priority - a.priority);
	}

	/**
	 * Check if controller has before action filters for this action
	 * @private
	 * @param {Object} obj - Controller instance
	 * @param {Object} request - Request object with toAction property
	 * @returns {boolean} True if matching filters exist
	 */
	__hasBeforeAction(obj, request){
		const matchingFilters = this._findMatchingFilters(this._beforeActionFilters, obj, request);
		return matchingFilters.length > 0;
	}

	/**
	 * Execute all matching before action filters
	 * @private
	 * @async
	 * @param {Object} obj - Controller instance
	 * @param {Object} request - Request object
	 * @param {EventEmitter} emitter - Event emitter for next() calls
	 * @returns {Promise<void>}
	 * @throws {Error} If any filter fails
	 */
	async __callBeforeAction(obj, request, emitter) {
		// Find all matching filters using optimized helper
		const matchingFilters = this._findMatchingFilters(this._beforeActionFilters, obj, request);

		if (matchingFilters.length === 0) {
			return;
		}

		const requestAction = this._normalizeAction(request.toAction);

		// Execute all matching filters in order
		for (const filter of matchingFilters) {
			const startTime = Date.now();
			try {
				// FIXED: Add timeout protection (5 seconds default)
				await this._executeWithTimeout(
					filter.callBack,
					filter.that,
					[request],
					emitter,
					this._filterTimeout
				);

				// Record successful filter execution timing
				const duration = Date.now() - startTime;
				logger.info({
					code: 'MC_FILTER_EXECUTED',
					message: 'Before action filter executed successfully',
					namespace: filter.namespace,
					action: requestAction,
					duration,
					filterType: 'before'
				});
			} catch (error) {
				const duration = Date.now() - startTime;

				// FIXED: Proper error handling with metrics
				logger.error({
					code: 'MC_FILTER_ERROR',
					message: 'Error in beforeAction filter',
					namespace: filter.namespace,
					action: requestAction,
					duration,
					filterType: 'before',
					error: error.message,
					stack: error.stack
				});

				// Send standardized error response (no sensitive info leaked)
				this._sendFilterErrorResponse(request, HTTP_STATUS.INTERNAL_ERROR, 'FILTER_ERROR');

				// Don't continue to other filters if one fails
				throw error;
			}
		}
	}

	/**
	 * Execute all matching after action filters
	 * @private
	 * @async
	 * @param {Object} obj - Controller instance
	 * @param {Object} request - Request object
	 * @returns {Promise<void>}
	 */
	async __callAfterAction(obj, request) {
		// Find all matching filters using optimized helper
		const matchingFilters = this._findMatchingFilters(this._afterActionFilters, obj, request);

		if (matchingFilters.length === 0) {
			return;
		}

		const requestAction = this._normalizeAction(request.toAction);

		// Execute all matching filters in order
		for (const filter of matchingFilters) {
			const startTime = Date.now();
			try {
				// FIXED: Add timeout protection (5 seconds default)
				await this._executeWithTimeout(
					filter.callBack,
					filter.that,
					[request],
					null,
					this._filterTimeout
				);

				// Record successful filter execution timing
				const duration = Date.now() - startTime;
				logger.info({
					code: 'MC_FILTER_EXECUTED',
					message: 'After action filter executed successfully',
					namespace: filter.namespace,
					action: requestAction,
					duration,
					filterType: 'after'
				});
			} catch (error) {
				const duration = Date.now() - startTime;

				// FIXED: Proper error handling with metrics
				logger.error({
					code: 'MC_FILTER_ERROR',
					message: 'Error in afterAction filter',
					namespace: filter.namespace,
					action: requestAction,
					duration,
					filterType: 'after',
					error: error.message,
					stack: error.stack
				});

				// After filters don't stop execution, just log
			}
		}
	}

	/**
	 * Execute filter function with timeout protection
	 * @private
	 * @async
	 * @param {Function} func - Filter callback to execute
	 * @param {Object} context - Execution context (controller instance)
	 * @param {Array} args - Arguments to pass to filter
	 * @param {EventEmitter|null} emitter - Event emitter for next() calls
	 * @param {number} timeout - Timeout in milliseconds
	 * @returns {Promise<*>} Filter result
	 * @throws {Error} If filter times out or throws error
	 */
	async _executeWithTimeout(func, context, args, emitter, timeout) {
		// Validate context exists
		if (!context) {
			throw new Error('Filter execution context is null or undefined');
		}

		// Validate request in args still has valid response
		if (args[0] && args[0].response) {
			const res = args[0].response;
			if (res._headerSent || res.headersSent) {
				logger.warn({
					code: 'MC_FILTER_WARN_HEADERS_SENT',
					message: 'Filter executing after headers already sent',
					namespace: context.__namespace
				});
			}
		}

		// Store emitter in context for next() call
		if (emitter) {
			context.__filterEmitter = emitter;
		}

		// Wrap execution in try-catch for synchronous errors
		try {
			return await Promise.race([
				// Execute the filter
				Promise.resolve(func.call(context, ...args)),
				// Timeout promise
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error(`Filter timeout after ${timeout}ms`)), timeout)
				)
			]);
		} catch (error) {
			// Ensure error has stack trace
			if (!error.stack) {
				error.stack = new Error().stack;
			}
			throw error;
		}
	}

	// ==================== Filter Management Utilities ====================

	/**
	 * Remove a before action filter
	 * @param {string|Array<string>} actionlist - Action name(s) to remove filter from
	 * @param {Function} func - Filter callback function to remove
	 * @returns {boolean} True if filter was removed
	 * @example
	 * this.removeBeforeAction('index', myFilterFunction);
	 */
	removeBeforeAction(actionlist, func) {
		const actions = Array.isArray(actionlist) ? actionlist : [actionlist];
		const initialLength = this._beforeActionFilters.length;

		this._beforeActionFilters = this._beforeActionFilters.filter(filter => {
			// Keep filter if callback doesn't match
			if (filter.callBack !== func) {
				return true;
			}

			// Keep filter if no actions match
			return !filter.actionList.some(action => actions.includes(action));
		});

		return this._beforeActionFilters.length < initialLength;
	}

	/**
	 * Remove an after action filter
	 * @param {string|Array<string>} actionlist - Action name(s) to remove filter from
	 * @param {Function} func - Filter callback function to remove
	 * @returns {boolean} True if filter was removed
	 * @example
	 * this.removeAfterAction('index', myFilterFunction);
	 */
	removeAfterAction(actionlist, func) {
		const actions = Array.isArray(actionlist) ? actionlist : [actionlist];
		const initialLength = this._afterActionFilters.length;

		this._afterActionFilters = this._afterActionFilters.filter(filter => {
			// Keep filter if callback doesn't match
			if (filter.callBack !== func) {
				return true;
			}

			// Keep filter if no actions match
			return !filter.actionList.some(action => actions.includes(action));
		});

		return this._afterActionFilters.length < initialLength;
	}

	/**
	 * Clear all filters (useful for testing)
	 * @param {string} [type] - 'before', 'after', or undefined for all
	 * @returns {void}
	 * @example
	 * this.clearFilters(); // Clear all
	 * this.clearFilters('before'); // Clear only before filters
	 */
	clearFilters(type) {
		if (!type || type === 'before') {
			this._beforeActionFilters = [];
		}
		if (!type || type === 'after') {
			this._afterActionFilters = [];
		}
	}

	/**
	 * Get all registered filters for debugging
	 * @param {string} [type] - 'before', 'after', or undefined for all
	 * @returns {Object} Filter information
	 * @example
	 * const filters = this.getRegisteredFilters();
	 * console.log(filters.before); // Array of before filters
	 */
	getRegisteredFilters(type) {
		const result = {};

		if (!type || type === 'before') {
			result.before = this._beforeActionFilters.map(f => ({
				namespace: f.namespace,
				actions: f.actionList,
				name: f.name,
				priority: f.priority,
				enabled: f.enabled,
				registeredAt: f.registeredAt
			}));
		}

		if (!type || type === 'after') {
			result.after = this._afterActionFilters.map(f => ({
				namespace: f.namespace,
				actions: f.actionList,
				name: f.name,
				priority: f.priority,
				enabled: f.enabled,
				registeredAt: f.registeredAt
			}));
		}

		return result;
	}

	/**
	 * Check if a filter is registered
	 * @param {string} type - 'before' or 'after'
	 * @param {string} action - Action name
	 * @param {string} [filterName] - Optional filter name to check
	 * @returns {boolean} True if filter exists
	 * @example
	 * if (this.hasFilter('before', 'index', 'authCheck')) { ... }
	 */
	hasFilter(type, action, filterName) {
		const filters = type === 'before' ? this._beforeActionFilters : this._afterActionFilters;
		const normalizedAction = this._normalizeAction(action);

		return filters.some(filter => {
			if (filterName && filter.name !== filterName) {
				return false;
			}

			return filter.actionList.some(a =>
				this._normalizeAction(a) === normalizedAction
			);
		});
	}

	/**
	 * Enable or disable a filter by name
	 * @param {string} type - 'before' or 'after'
	 * @param {string} filterName - Filter name
	 * @param {boolean} enabled - True to enable, false to disable
	 * @returns {boolean} True if filter was found and updated
	 * @example
	 * this.setFilterEnabled('before', 'authCheck', false); // Disable filter
	 */
	setFilterEnabled(type, filterName, enabled) {
		const filters = type === 'before' ? this._beforeActionFilters : this._afterActionFilters;
		let found = false;

		filters.forEach(filter => {
			if (filter.name === filterName) {
				filter.enabled = enabled;
				found = true;
			}
		});

		return found;
	}

	// ==================== Test Utilities ====================

	/**
	 * Get filter count for testing
	 * @private
	 * @param {string} [type] - 'before', 'after', or undefined for total
	 * @returns {number} Number of registered filters
	 */
	_getFilterCount(type) {
		if (type === 'before') {
			return this._beforeActionFilters.length;
		}
		if (type === 'after') {
			return this._afterActionFilters.length;
		}
		return this._beforeActionFilters.length + this._afterActionFilters.length;
	}

	/**
	 * Reset all filters for test isolation
	 * @private
	 * @returns {void}
	 */
	_resetFilters() {
		this._beforeActionFilters = [];
		this._afterActionFilters = [];
	}

	/**
	 * Check if a specific filter is registered by callback reference
	 * @private
	 * @param {string} type - 'before' or 'after'
	 * @param {Function} callback - Filter callback to check
	 * @returns {boolean} True if filter is registered
	 */
	_isFilterRegistered(type, callback) {
		const filters = type === 'before' ? this._beforeActionFilters : this._afterActionFilters;
		return filters.some(filter => filter.callBack === callback);
	}

	/**
	 * Get filter timeout value for testing
	 * @private
	 * @returns {number} Timeout in milliseconds
	 */
	_getFilterTimeout() {
		return this._filterTimeout;
	}

	/**
	 * Set filter timeout value (useful for testing)
	 * @private
	 * @param {number} timeout - Timeout in milliseconds
	 * @returns {void}
	 */
	_setFilterTimeout(timeout) {
		if (typeof timeout === 'number' && timeout > 0) {
			this._filterTimeout = timeout;
		} else {
			logger.warn({
				code: 'MC_FILTER_INVALID_TIMEOUT',
				message: 'Invalid timeout value, must be positive number',
				timeout
			});
		}
	}

	/**
	 * Continue to the next filter or action
	 * Call this from beforeAction filters to proceed with request execution
	 * @returns {void}
	 * @example
	 * this.beforeAction('index', function() {
	 *   if (this.isAuthenticated()) {
	 *     this.next(); // Continue
	 *   } else {
	 *     this.redirectTo('/login'); // Stop and redirect
	 *   }
	 * });
	 */
	next(){
		if (this.__filterEmitter) {
			this.__filterEmitter.emit("controller");
		} else {
			logger.warn({
				code: 'MC_FILTER_WARN',
				message: 'next() called but no emitter available',
				namespace: this.__namespace
			});
		}
	}
}

// Export and lazy register (prevents circular dependency - Spring/Angular pattern)
module.exports = MasterActionFilters;

setImmediate(() => {
	const master = require('./MasterControl');
	if (master && master.extendController) {
		master.extendController(MasterActionFilters);
	}
});
