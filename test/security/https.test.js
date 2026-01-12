// HTTPS and Open Redirect Protection Tests
const master = require('../../MasterControl');
require('../../MasterAction');

describe('HTTPS and Open Redirect Protection', () => {

	class MockController {
		constructor() {
			Object.assign(this, master.controllerExtensions);
			this.__requestObject = {
				request: {
					connection: {},
					headers: {}
				},
				response: {
					_headerSent: false,
					headersSent: false,
					writeHead: jest.fn(),
					end: jest.fn(),
					setHeader: jest.fn()
				},
				pathName: '/login'
			};
		}

		redirectTo(url) {
			this.__requestObject.response.writeHead(302, { 'Location': url });
			this.__requestObject.response.end();
		}

		returnError(code, message) {
			this.__requestObject.response.writeHead(code, { 'Content-Type': 'application/json' });
			this.__requestObject.response.end(JSON.stringify({ error: message }));
		}
	}

	describe('requireHTTPS() - Open Redirect Fix', () => {
		beforeEach(() => {
			// Setup test environment
			master.env = master.env || {};
			master.env.server = {
				hostname: 'example.com',
				httpsPort: 443
			};
		});

		test('should NOT use Host header from request', () => {
			const controller = new MockController();
			controller.__requestObject.request.connection.encrypted = false;
			controller.__requestObject.request.headers.host = 'evil.com';

			controller.requireHTTPS();

			// Should redirect to configured host, NOT Host header
			const writeHeadCalls = controller.__requestObject.response.writeHead.mock.calls;
			const redirectCall = writeHeadCalls.find(call => call[0] === 302);

			expect(redirectCall).toBeTruthy();
			expect(redirectCall[1].Location).toBe('https://example.com/login');
			expect(redirectCall[1].Location).not.toContain('evil.com');
		});

		test('should use configured hostname', () => {
			const controller = new MockController();
			controller.__requestObject.request.connection.encrypted = false;

			master.env.server.hostname = 'myapp.com';

			controller.requireHTTPS();

			const writeHeadCalls = controller.__requestObject.response.writeHead.mock.calls;
			const redirectCall = writeHeadCalls.find(call => call[0] === 302);

			expect(redirectCall[1].Location).toBe('https://myapp.com/login');
		});

		test('should include port if not 443', () => {
			const controller = new MockController();
			controller.__requestObject.request.connection.encrypted = false;

			master.env.server.hostname = 'example.com';
			master.env.server.httpsPort = 8443;

			controller.requireHTTPS();

			const writeHeadCalls = controller.__requestObject.response.writeHead.mock.calls;
			const redirectCall = writeHeadCalls.find(call => call[0] === 302);

			expect(redirectCall[1].Location).toBe('https://example.com:8443/login');
		});

		test('should return error if hostname not configured', () => {
			const controller = new MockController();
			controller.__requestObject.request.connection.encrypted = false;

			master.env.server.hostname = 'localhost';

			const result = controller.requireHTTPS();

			expect(result).toBe(false);
			expect(controller.__requestObject.response.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
		});

		test('should allow request if already HTTPS', () => {
			const controller = new MockController();
			controller.__requestObject.request.connection.encrypted = true;

			const result = controller.requireHTTPS();

			expect(result).toBe(true);
			expect(controller.__requestObject.response.writeHead).not.toHaveBeenCalled();
		});

		test('should detect HTTPS from X-Forwarded-Proto header', () => {
			const controller = new MockController();
			controller.__requestObject.request.connection.encrypted = false;
			controller.__requestObject.request.headers['x-forwarded-proto'] = 'https';

			const result = controller.requireHTTPS();

			expect(result).toBe(true);
		});
	});

	describe('isSecure()', () => {
		test('should return true for encrypted connection', () => {
			const controller = new MockController();
			controller.__requestObject.request.connection.encrypted = true;

			expect(controller.isSecure()).toBe(true);
		});

		test('should return true for X-Forwarded-Proto: https', () => {
			const controller = new MockController();
			controller.__requestObject.request.headers['x-forwarded-proto'] = 'https';

			expect(controller.isSecure()).toBe(true);
		});

		test('should return false for HTTP', () => {
			const controller = new MockController();
			controller.__requestObject.request.connection.encrypted = false;
			controller.__requestObject.request.headers['x-forwarded-proto'] = 'http';

			expect(controller.isSecure()).toBe(false);
		});
	});

	describe('Real-World Attack Scenarios', () => {
		beforeEach(() => {
			master.env = master.env || {};
			master.env.server = {
				hostname: 'legitimate.com',
				httpsPort: 443
			};
		});

		test('should prevent phishing via Host header manipulation', () => {
			const controller = new MockController();
			controller.__requestObject.request.connection.encrypted = false;

			// Attacker sets malicious Host header
			controller.__requestObject.request.headers.host = 'phishing-site.com';
			controller.__requestObject.pathName = '/login';

			controller.requireHTTPS();

			// Should redirect to legitimate site, not attacker's
			const writeHeadCalls = controller.__requestObject.response.writeHead.mock.calls;
			const redirectCall = writeHeadCalls.find(call => call[0] === 302);

			expect(redirectCall[1].Location).toBe('https://legitimate.com/login');
			expect(redirectCall[1].Location).not.toContain('phishing-site.com');
		});

		test('should prevent redirect to external domain', () => {
			const controller = new MockController();
			controller.__requestObject.request.connection.encrypted = false;

			// Attacker tries various Host header values
			const maliciousHosts = [
				'evil.com',
				'attacker.net',
				'phishing.org',
				'legitimate.com.evil.com'
			];

			maliciousHosts.forEach(host => {
				controller.__requestObject.request.headers.host = host;
				controller.__requestObject.response.writeHead.mockClear();

				controller.requireHTTPS();

				const writeHeadCalls = controller.__requestObject.response.writeHead.mock.calls;
				const redirectCall = writeHeadCalls.find(call => call[0] === 302);

				expect(redirectCall[1].Location).toBe('https://legitimate.com/login');
			});
		});

		test('should preserve original path in redirect', () => {
			const controller = new MockController();
			controller.__requestObject.request.connection.encrypted = false;
			controller.__requestObject.pathName = '/admin/users/123';

			controller.requireHTTPS();

			const writeHeadCalls = controller.__requestObject.response.writeHead.mock.calls;
			const redirectCall = writeHeadCalls.find(call => call[0] === 302);

			expect(redirectCall[1].Location).toBe('https://legitimate.com/admin/users/123');
		});
	});
});
