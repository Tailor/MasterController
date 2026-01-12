// version 2.0 - FIXED: Instance-level filters, async support, multiple filters
var master = require('./MasterControl');
const { logger } = require('./error/MasterErrorLogger');

class MasterActionFilters {

	constructor() {
		// FIXED: Instance-level storage instead of module-level
		// Each controller gets its own filter arrays
		this._beforeActionFilters = [];
		this._afterActionFilters = [];
	}

	// Register a before action filter
	// FIXED: Adds to array instead of overwriting
	beforeAction(actionlist, func){
		if (typeof func !== 'function') {
			master.error.log("beforeAction callback not a function", "warn");
			return;
		}

		// FIXED: Push to array, don't overwrite
		this._beforeActionFilters.push({
			namespace: this.__namespace,
			actionList: Array.isArray(actionlist) ? actionlist : [actionlist],
			callBack: func,
			that: this
		});
	}

	// Register an after action filter
	// FIXED: Adds to array instead of overwriting
	afterAction(actionlist, func){
		if (typeof func !== 'function') {
			master.error.log("afterAction callback not a function", "warn");
			return;
		}

		// FIXED: Push to array, don't overwrite
		this._afterActionFilters.push({
			namespace: this.__namespace,
			actionList: Array.isArray(actionlist) ? actionlist : [actionlist],
			callBack: func,
			that: this
		});
	}

	// Check if controller has before action filters for this action
	__hasBeforeAction(obj, request){
		if (!this._beforeActionFilters || this._beforeActionFilters.length === 0) {
			return false;
		}

		return this._beforeActionFilters.some(filter => {
			if (filter.namespace !== obj.__namespace) {
				return false;
			}

			const requestAction = request.toAction.replace(/\s/g, '');
			return filter.actionList.some(action => {
				const filterAction = action.replace(/\s/g, '');
				return filterAction === requestAction;
			});
		});
	}

	// Execute all matching before action filters
	// FIXED: Async support, error handling, timeout protection, no variable shadowing
	async __callBeforeAction(obj, request, emitter) {
		if (!this._beforeActionFilters || this._beforeActionFilters.length === 0) {
			return;
		}

		// Find all matching filters
		const requestAction = request.toAction.replace(/\s/g, '');
		const matchingFilters = this._beforeActionFilters.filter(filter => {
			if (filter.namespace !== obj.__namespace) {
				return false;
			}

			return filter.actionList.some(actionName => {
				const normalizedAction = actionName.replace(/\s/g, '');
				return normalizedAction === requestAction;
			});
		});

		// Execute all matching filters in order
		for (const filter of matchingFilters) {
			try {
				// FIXED: Add timeout protection (5 seconds default)
				await this._executeWithTimeout(
					filter.callBack,
					filter.that,
					[request],
					emitter,
					5000
				);
			} catch (error) {
				// FIXED: Proper error handling
				logger.error({
					code: 'MC_FILTER_ERROR',
					message: 'Error in beforeAction filter',
					namespace: filter.namespace,
					action: requestAction,
					error: error.message,
					stack: error.stack
				});

				// Send error response
				const res = request.response;
				if (res && !res._headerSent && !res.headersSent) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({
						error: 'Internal Server Error',
						message: master.environmentType === 'development' ? error.message : 'Filter execution failed'
					}));
				}

				// Don't continue to other filters if one fails
				throw error;
			}
		}
	}

	// Execute all matching after action filters
	// FIXED: Async support, error handling, no variable shadowing
	async __callAfterAction(obj, request) {
		if (!this._afterActionFilters || this._afterActionFilters.length === 0) {
			return;
		}

		// Find all matching filters
		const requestAction = request.toAction.replace(/\s/g, '');
		const matchingFilters = this._afterActionFilters.filter(filter => {
			if (filter.namespace !== obj.__namespace) {
				return false;
			}

			return filter.actionList.some(actionName => {
				const normalizedAction = actionName.replace(/\s/g, '');
				return normalizedAction === requestAction;
			});
		});

		// Execute all matching filters in order
		for (const filter of matchingFilters) {
			try {
				// FIXED: Add timeout protection (5 seconds default)
				await this._executeWithTimeout(
					filter.callBack,
					filter.that,
					[request],
					null,
					5000
				);
			} catch (error) {
				// FIXED: Proper error handling
				logger.error({
					code: 'MC_FILTER_ERROR',
					message: 'Error in afterAction filter',
					namespace: filter.namespace,
					action: requestAction,
					error: error.message,
					stack: error.stack
				});

				// After filters don't stop execution, just log
			}
		}
	}

	// FIXED: Execute function with timeout protection
	async _executeWithTimeout(func, context, args, emitter, timeout) {
		// Store emitter in context for next() call
		if (emitter) {
			context.__filterEmitter = emitter;
		}

		return Promise.race([
			// Execute the filter
			Promise.resolve(func.call(context, ...args)),
			// Timeout promise
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error(`Filter timeout after ${timeout}ms`)), timeout)
			)
		]);
	}

	// FIXED: Request-scoped next() function
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

master.extendController(MasterActionFilters);
