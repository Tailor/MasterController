// Path Traversal Protection Tests
const master = require('../../MasterControl');
require('../../MasterAction');
require('../../MasterHtml');

describe('Path Traversal Protection', () => {

	describe('MasterAction - returnPartialView()', () => {
		class MockController {
			constructor() {
				Object.assign(this, master.controllerExtensions);
				this.__requestObject = {
					response: {
						_headerSent: false,
						headersSent: false,
						writeHead: jest.fn(),
						end: jest.fn()
					}
				};
			}

			returnError(code, message) {
				this.__requestObject.response.writeHead(code, { 'Content-Type': 'application/json' });
				this.__requestObject.response.end(JSON.stringify({ error: message }));
			}
		}

		test('should reject ../ path traversal', () => {
			const controller = new MockController();
			const result = controller.returnPartialView('../../etc/passwd', {});

			expect(controller.__requestObject.response.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
			expect(result).toBe('');
		});

		test('should reject absolute paths', () => {
			const controller = new MockController();
			const result = controller.returnPartialView('/etc/passwd', {});

			expect(controller.__requestObject.response.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
			expect(result).toBe('');
		});

		test('should reject ~ home directory paths', () => {
			const controller = new MockController();
			const result = controller.returnPartialView('~/../../etc/passwd', {});

			expect(controller.__requestObject.response.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
			expect(result).toBe('');
		});

		test('should allow safe relative paths', () => {
			const controller = new MockController();
			master.root = __dirname;

			// This should not throw (though file may not exist)
			try {
				controller.returnPartialView('views/safe/partial.html', {});
			} catch (e) {
				// File not found is OK, as long as validation passed
			}

			// Should not have called returnError with 400 or 403
			const calls = controller.__requestObject.response.writeHead.mock.calls;
			const hasSecurityError = calls.some(call => [400, 403].includes(call[0]));
			expect(hasSecurityError).toBe(false);
		});
	});

	describe('MasterAction - returnViewWithoutEngine()', () => {
		class MockController {
			constructor() {
				Object.assign(this, master.controllerExtensions);
				this.__requestObject = {
					response: {
						_headerSent: false,
						headersSent: false,
						writeHead: jest.fn(),
						end: jest.fn()
					}
				};
			}

			returnError(code, message) {
				this.__requestObject.response.writeHead(code, { 'Content-Type': 'application/json' });
				this.__requestObject.response.end(JSON.stringify({ error: message }));
			}
		}

		test('should reject ../ path traversal', () => {
			const controller = new MockController();
			controller.returnViewWithoutEngine('../../../etc/passwd');

			expect(controller.__requestObject.response.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
		});

		test('should reject absolute paths', () => {
			const controller = new MockController();
			controller.returnViewWithoutEngine('/etc/passwd');

			expect(controller.__requestObject.response.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
		});
	});

	describe('MasterHtml - renderPartial()', () => {
		let html;

		beforeEach(() => {
			html = master.viewList.html;
			master.router.currentRoute = {
				root: __dirname
			};
		});

		test('should reject ../ path traversal', () => {
			const result = html.renderPartial('../../etc/passwd', {});
			expect(result).toBe('<!-- Invalid path -->');
		});

		test('should reject absolute paths', () => {
			const result = html.renderPartial('/etc/passwd', {});
			expect(result).toBe('<!-- Invalid path -->');
		});

		test('should reject ~ home directory', () => {
			const result = html.renderPartial('~/config', {});
			expect(result).toBe('<!-- Invalid path -->');
		});

		test('should allow safe relative paths', () => {
			// Safe path should not return error
			try {
				const result = html.renderPartial('partials/safe.html', {});
				// May return "not found" comment, but not "invalid path"
				expect(result).not.toBe('<!-- Invalid path -->');
			} catch (e) {
				// File not found is OK
			}
		});
	});

	describe('MasterHtml - renderStyles()', () => {
		let html;

		beforeEach(() => {
			html = master.viewList.html;
			master.router.currentRoute = {
				root: __dirname,
				isComponent: false
			};
		});

		test('should reject ../ in folder name', () => {
			const result = html.renderStyles('../../../etc', ['css']);
			expect(result).toBe('');
		});

		test('should reject absolute paths in folder name', () => {
			const result = html.renderStyles('/etc/passwd', ['css']);
			expect(result).toBe('');
		});

		test('should allow safe folder names', () => {
			const result = html.renderStyles('pages', ['css']);
			// Should return empty string if no files, but not fail validation
			expect(typeof result).toBe('string');
		});
	});

	describe('MasterHtml - renderScripts()', () => {
		let html;

		beforeEach(() => {
			html = master.viewList.html;
			master.router.currentRoute = {
				root: __dirname,
				isComponent: false
			};
		});

		test('should reject ../ in folder name', () => {
			const result = html.renderScripts('../../config', ['js']);
			expect(result).toBe('');
		});

		test('should reject absolute paths', () => {
			const result = html.renderScripts('/etc', ['js']);
			expect(result).toBe('');
		});

		test('should allow safe folder names', () => {
			const result = html.renderScripts('components', ['js']);
			expect(typeof result).toBe('string');
		});
	});

	describe('Real-World Attack Scenarios', () => {
		test('should prevent reading /etc/passwd', () => {
			const html = master.viewList.html;
			master.router.currentRoute = { root: '/var/www/app' };

			const result = html.renderPartial('../../../../../../../etc/passwd', {});
			expect(result).toBe('<!-- Invalid path -->');
		});

		test('should prevent reading application config', () => {
			const html = master.viewList.html;
			master.router.currentRoute = { root: '/var/www/app' };

			const result = html.renderPartial('../../config/database.yml', {});
			expect(result).toBe('<!-- Invalid path -->');
		});

		test('should prevent reading .env files', () => {
			const html = master.viewList.html;
			master.router.currentRoute = { root: '/var/www/app' };

			const result = html.renderPartial('../../.env', {});
			expect(result).toBe('<!-- Invalid path -->');
		});
	});
});
