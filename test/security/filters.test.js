// Action Filter Tests for MasterActionFilters.js
const master = require('../../MasterControl');
require('../../MasterActionFilters');

describe('Action Filters - Fixed Architecture', () => {

	class TestController {
		constructor() {
			this.__namespace = 'test';
			this._beforeActionFilters = [];
			this._afterActionFilters = [];

			// Import methods from MasterActionFilters
			Object.assign(this, master.controllerExtensions);
		}
	}

	describe('Multiple Filters Support', () => {
		test('should support multiple beforeAction filters', () => {
			const controller = new TestController();

			controller.beforeAction(['show'], () => console.log('Filter 1'));
			controller.beforeAction(['show'], () => console.log('Filter 2'));
			controller.beforeAction(['edit'], () => console.log('Filter 3'));

			// Should have 3 filters
			expect(controller._beforeActionFilters).toHaveLength(3);
		});

		test('should not overwrite previous filters', () => {
			const controller = new TestController();

			controller.beforeAction(['show'], () => 'first');
			controller.beforeAction(['show'], () => 'second');

			// Both filters should exist
			expect(controller._beforeActionFilters[0].callBack()).toBe('first');
			expect(controller._beforeActionFilters[1].callBack()).toBe('second');
		});

		test('should support multiple afterAction filters', () => {
			const controller = new TestController();

			controller.afterAction(['index'], () => {});
			controller.afterAction(['index'], () => {});

			expect(controller._afterActionFilters).toHaveLength(2);
		});
	});

	describe('Instance-Level Filters (Not Global)', () => {
		test('should not share filters between controllers', () => {
			const controller1 = new TestController();
			const controller2 = new TestController();

			controller1.__namespace = 'users';
			controller2.__namespace = 'posts';

			controller1.beforeAction(['show'], () => 'users filter');
			controller2.beforeAction(['index'], () => 'posts filter');

			// Each controller has independent filters
			expect(controller1._beforeActionFilters).toHaveLength(1);
			expect(controller2._beforeActionFilters).toHaveLength(1);

			expect(controller1._beforeActionFilters[0].namespace).toBe('users');
			expect(controller2._beforeActionFilters[0].namespace).toBe('posts');
		});

		test('should not have race conditions between requests', () => {
			// Simulate two concurrent requests
			const request1Controller = new TestController();
			const request2Controller = new TestController();

			request1Controller.__namespace = 'users';
			request2Controller.__namespace = 'admin';

			request1Controller.beforeAction(['show'], () => 'request 1');
			request2Controller.beforeAction(['dashboard'], () => 'request 2');

			// Each request has its own filter state
			expect(request1Controller._beforeActionFilters[0].callBack()).toBe('request 1');
			expect(request2Controller._beforeActionFilters[0].callBack()).toBe('request 2');
		});
	});

	describe('Filter Execution', () => {
		test('should execute all matching filters in order', async () => {
			const controller = new TestController();
			const executionOrder = [];

			controller.beforeAction(['show'], () => executionOrder.push('first'));
			controller.beforeAction(['show'], () => executionOrder.push('second'));
			controller.beforeAction(['show'], () => executionOrder.push('third'));

			const request = {
				toAction: 'show',
				response: { _headerSent: false, headersSent: false }
			};

			await controller.__callBeforeAction(controller, request, null);

			expect(executionOrder).toEqual(['first', 'second', 'third']);
		});

		test('should only execute filters for matching actions', async () => {
			const controller = new TestController();
			const executed = [];

			controller.beforeAction(['show'], () => executed.push('show'));
			controller.beforeAction(['edit'], () => executed.push('edit'));
			controller.beforeAction(['destroy'], () => executed.push('destroy'));

			const request = {
				toAction: 'show',
				response: { _headerSent: false, headersSent: false }
			};

			await controller.__callBeforeAction(controller, request, null);

			expect(executed).toEqual(['show']);
		});
	});

	describe('Async Support', () => {
		test('should support async filters', async () => {
			const controller = new TestController();
			let asyncCompleted = false;

			controller.beforeAction(['index'], async () => {
				await new Promise(resolve => setTimeout(resolve, 10));
				asyncCompleted = true;
			});

			const request = {
				toAction: 'index',
				response: { _headerSent: false, headersSent: false }
			};

			await controller.__callBeforeAction(controller, request, null);

			expect(asyncCompleted).toBe(true);
		});

		test('should await each filter before continuing', async () => {
			const controller = new TestController();
			const order = [];

			controller.beforeAction(['index'], async () => {
				order.push('start-1');
				await new Promise(resolve => setTimeout(resolve, 20));
				order.push('end-1');
			});

			controller.beforeAction(['index'], async () => {
				order.push('start-2');
				await new Promise(resolve => setTimeout(resolve, 10));
				order.push('end-2');
			});

			const request = {
				toAction: 'index',
				response: { _headerSent: false, headersSent: false }
			};

			await controller.__callBeforeAction(controller, request, null);

			// Should execute in order, awaiting each
			expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
		});
	});

	describe('Error Handling', () => {
		test('should catch and log filter errors', async () => {
			const controller = new TestController();

			controller.beforeAction(['index'], () => {
				throw new Error('Filter error');
			});

			const request = {
				toAction: 'index',
				response: {
					_headerSent: false,
					headersSent: false,
					writeHead: jest.fn(),
					end: jest.fn()
				}
			};

			await expect(
				controller.__callBeforeAction(controller, request, null)
			).rejects.toThrow('Filter error');

			// Should send error response
			expect(request.response.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
		});

		test('should stop filter chain on error', async () => {
			const controller = new TestController();
			const executed = [];

			controller.beforeAction(['index'], () => {
				executed.push('first');
				throw new Error('Stop here');
			});

			controller.beforeAction(['index'], () => {
				executed.push('second'); // Should not execute
			});

			const request = {
				toAction: 'index',
				response: {
					_headerSent: false,
					headersSent: false,
					writeHead: jest.fn(),
					end: jest.fn()
				}
			};

			try {
				await controller.__callBeforeAction(controller, request, null);
			} catch (e) {}

			expect(executed).toEqual(['first']);
		});
	});

	describe('Timeout Protection', () => {
		test('should timeout slow filters', async () => {
			const controller = new TestController();

			controller.beforeAction(['index'], async () => {
				// Simulate slow operation (6 seconds, timeout is 5 seconds)
				await new Promise(resolve => setTimeout(resolve, 6000));
			});

			const request = {
				toAction: 'index',
				response: {
					_headerSent: false,
					headersSent: false,
					writeHead: jest.fn(),
					end: jest.fn()
				}
			};

			await expect(
				controller.__callBeforeAction(controller, request, null)
			).rejects.toThrow(/timeout/i);
		}, 10000); // Increase test timeout
	});

	describe('Variable Shadowing Fix', () => {
		test('should not have variable shadowing bugs', async () => {
			const controller = new TestController();
			const actions = ['show', 'edit', 'destroy'];

			// This used to cause bugs due to variable shadowing
			controller.beforeAction(actions, (req) => {
				// Action list should be properly iterated
			});

			const request = {
				toAction: 'edit',
				response: { _headerSent: false, headersSent: false }
			};

			// Should execute without errors
			await expect(
				controller.__callBeforeAction(controller, request, null)
			).resolves.not.toThrow();
		});
	});
});
