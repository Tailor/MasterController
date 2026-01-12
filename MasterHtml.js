// version 0.0.25

var master = require('./MasterControl');
var fs = require('fs');
var tempClass =  require('./MasterTemplate');
var toolClass =  require('./MasterTools');
var temp = new tempClass();
var tools = new toolClass();

// Enhanced error handling
const { handleTemplateError } = require('./error/MasterBackendErrorHandler');
const { safeReadFile, safeFileExists } = require('./error/MasterErrorMiddleware');
const { logger } = require('./error/MasterErrorLogger');

// Security - Sanitization
const { sanitizeTemplateHTML, sanitizeUserHTML, escapeHTML } = require('./security/MasterSanitizer');

class html {

	javaScriptSerializer(name, obj){
		// SECURITY: Escape closing script tags and dangerous characters
		const jsonStr = JSON.stringify(obj)
			.replace(/</g, '\\u003c')
			.replace(/>/g, '\\u003e')
			.replace(/&/g, '\\u0026')
			.replace(/\u2028/g, '\\u2028')
			.replace(/\u2029/g, '\\u2029');

		return `<script type="text/javascript">
			${escapeHTML(name)} = ${jsonStr}
		</script>`;
	}

	// render partial views
	renderPartial(path, data){
		try {
			// SECURITY: Validate path to prevent traversal attacks
			if (!path || path.includes('..') || path.includes('~') || path.startsWith('/')) {
				logger.warn({
					code: 'MC_SECURITY_PATH_TRAVERSAL',
					message: 'Path traversal attempt blocked in renderPartial',
					path: path
				});
				return '<!-- Invalid path -->';
			}

			var partialViewUrl = `/app/views/${path}`;
			var fullPath = master.router.currentRoute.root + partialViewUrl;

			const fileResult = safeReadFile(fs, fullPath);

			if (!fileResult.success) {
				logger.warn({
					code: 'MC_ERR_VIEW_NOT_FOUND',
					message: `Partial view not found: ${path}`,
					file: fullPath
				});
				return `<!-- Partial view not found: ${path} -->`;
			}

			var partialView = null;
			if(master.overwrite.isTemplate){
				partialView = master.overwrite.templateRender(data, "renderPartialView");
			}
			else{
				partialView =  temp.htmlBuilder(fileResult.content, data);
			}

			return partialView;
		} catch (error) {
			const mcError = handleTemplateError(error, path, data);
			logger.error({
				code: mcError.code,
				message: mcError.message,
				file: path,
				originalError: error
			});
			return `<!-- Error rendering partial: ${path} -->`;
		}

	}

	   // render all your link tags styles given the folder location
	   renderStyles(folderName, typeArray){
		// SECURITY: Validate folder name to prevent path traversal
		if (folderName && (folderName.includes('..') || folderName.includes('~') || folderName.startsWith('/'))) {
			logger.warn({
				code: 'MC_SECURITY_PATH_TRAVERSAL',
				message: 'Path traversal attempt blocked in renderStyles',
				folderName: folderName
			});
			return '';
		}

		var styles = [];
		var styleFolder = `/app/assets/stylesheets/`;
		var rootLocation = master.router.currentRoute.root;
		var extention = "";

		if(master.router.currentRoute.isComponent === true){
			extention = tools.getBackSlashBySection(master.router.currentRoute.root, 2, "/");
		}

		var type = typeArray === undefined ? ["css"] : typeArray;

		if(folderName){
			styleFolder = `${styleFolder}${folderName}/`;
		 }
		 
		 if (fs.existsSync(`${rootLocation}${styleFolder}`)) {
			fs.readdirSync(`${rootLocation}${styleFolder}`).forEach(function(file){

					var fileExtension = file.replace(/^.*\./, '');
					if(type.indexOf(fileExtension) >= 0){
						var fileLocatoon = `${styleFolder}${file}`;
						if(master.router.currentRoute.isComponent === true){
							styles.push(`<link rel="stylesheet" type="text/${type}" href="/${extention}${fileLocatoon}">`);
						}
						else{
							styles.push(`<link rel="stylesheet" type="text/${type}" href="${fileLocatoon}">`);
						}
					}
			});
		}
	   	var partialView = null;
		
		if(master.overwrite.isTemplate){
			partialView = master.overwrite.templateRender({}, "renderStyles");
		}
		else{
			partialView =  temp.htmlBuilder(styles.join(""),{});	
		}

		return partialView;
	}

	// renders all scripts in main folder or folder location inside of javascript also its type specific if you provide type
	renderScripts(folderName, typeArray){
		// SECURITY: Validate folder name to prevent path traversal
		if (folderName && (folderName.includes('..') || folderName.includes('~') || folderName.startsWith('/'))) {
			logger.warn({
				code: 'MC_SECURITY_PATH_TRAVERSAL',
				message: 'Path traversal attempt blocked in renderScripts',
				folderName: folderName
			});
			return '';
		}

		var scripts = [];
		var jsFolder =`/app/assets/javascripts/`;
		var rootLocation = master.router.currentRoute.root;
		var extention = "";
		//components/auth/app/assets/javascripts/pages/changePassword.js
		if(master.router.currentRoute.isComponent === true){
			extention = tools.getBackSlashBySection(master.router.currentRoute.root, 2, "/");
		}

		var type = typeArray === undefined ? ["js"] : typeArray;

		if(folderName){
			jsFolder = `${jsFolder}${folderName}/`;
		}

		if (fs.existsSync(`${rootLocation}${jsFolder}`)) {
			fs.readdirSync(`${rootLocation}${jsFolder}`).forEach(function(file){
				var fileExtension = file.replace(/^.*\./, '');
				if(type.indexOf(fileExtension) >= 0){
					var fileLocatoon = `${jsFolder}${file}`;
					if(master.router.currentRoute.isComponent === true){
						scripts.push(`<script src="/${extention}${fileLocatoon}"></script>`);
					}
					else{
						scripts.push(`<script src="${fileLocatoon}"></script>`);
					}
				}
		   });
		}

		var partialView = null;

		if(master.overwrite.isTemplate){
			partialView = master.overwrite.templateRender({}, "renderScripts");
		}
		else{
			partialView =  temp.htmlBuilder(scripts.join(""),{});	
		}

	   return partialView;
	}


	// renders js using location
	renderJS(folderName, name){
		if(folderName === undefined && name === undefined){
			return "";
		}
		else{
			var rootLocation = master.router.currentRoute.root;
			var jsFolder = `/app/assets/javascripts/`;
			if(master.router.currentRoute.isComponent === true){
				rootLocation = tools.getBackSlashBySection(master.router.currentRoute.root, 2, "/");
				jsFolder = `${rootLocation}${jsFolder}`;
			}
			if(folderName){
				jsFolder = `${jsFolder}${folderName}/${name}`;
			}
			return `<script type="text/javascript" src="/${jsFolder}"></script>`;
		}
	}

	// render css directly on the page suing location name
	renderCss(folderName, name){
		if(folderName === undefined && name === undefined){
			return "";
		}
		else{
			var styleFolder = `/app/assets/stylesheets/`;
			var rootLocation = master.router.currentRoute.root;
			if(master.router.currentRoute.isComponent === true){
				rootLocation = tools.getBackSlashBySection(master.router.currentRoute.root, 2, "/");
				styleFolder =  `${rootLocation}${styleFolder}`;
			}
			
			if(folderName){
				styleFolder = `${styleFolder}${folderName}/${name}`;
			}
			return `<link rel="stylesheet" type="text/css" href="/${styleFolder}">`;
		}
	}

	// return link tag
	linkTo(name, location){
		const safeName = escapeHTML(String(name));
		const safeLocation = escapeHTML(String(location));
		return `<a href="${safeLocation}">${safeName}</a>`;
	}

	   // return image tag
	imgTag(alt, location){
		const safeAlt = escapeHTML(String(alt));
		const safeLocation = escapeHTML(String(location));
		return `<img src="${safeLocation}" alt="${safeAlt}">`;
	}

	   // return text are tag
	textAreaTag(name, message, obj){
		const safeName = escapeHTML(String(name));
		const safeMessage = escapeHTML(String(message));

		let textArea = `<textarea name="${safeName}"`;

		for (const [key, value] of Object.entries(obj || {})) {
			const safeKey = escapeHTML(String(key));
			const safeValue = escapeHTML(String(value));
			textArea += ` ${safeKey}="${safeValue}"`;
		}

		textArea += `>${safeMessage}</textarea>`;

		return textArea;
	}

	   // form element builder starter
	formTag(location, obj){
		const safeLocation = escapeHTML(String(location));
		let form = `<form action="${safeLocation}"`;

		for (const [key, value] of Object.entries(obj || {})) {
			const safeKey = escapeHTML(String(key));
			const safeValue = escapeHTML(String(value));
			form += ` ${safeKey}="${safeValue}"`;
		}

		return form + ">";
	}

	   // form element builder ender
	formTagEnd(){
		return '</form>';
	}
		   // return text tag
	passwordFieldTag(name, obj){
		const safeName = escapeHTML(String(name));
		let passwordField = `<input type="password" name="${safeName}"`;

		for (const [key, value] of Object.entries(obj || {})) {
			const safeKey = escapeHTML(String(key));
			const safeValue = escapeHTML(String(value));
			passwordField += ` ${safeKey}="${safeValue}"`;
		}

		passwordField += '/>';

		return passwordField;
	}

	   // return password field tag
	textFieldTag(name, obj){
		const safeName = escapeHTML(String(name));
		let textField = `<input type="text" name="${safeName}"`;

		for (const [key, value] of Object.entries(obj || {})) {
			const safeKey = escapeHTML(String(key));
			const safeValue = escapeHTML(String(value));
			textField += ` ${safeKey}="${safeValue}"`;
		}

		textField += '/>';
		return textField;
	   };

	   // hidden field tag
	hiddenFieldTag(name, value, obj){
		const safeName = escapeHTML(String(name));
		const safeValue = escapeHTML(String(value));

		let hiddenField = `<input type="hidden" name="${safeName}" value="${safeValue}"`;

		for (const [key, val] of Object.entries(obj || {})) {
			const safeKey = escapeHTML(String(key));
			const safeVal = escapeHTML(String(val));
			hiddenField += ` ${safeKey}="${safeVal}"`;
		}

		hiddenField += '/>';

		return hiddenField;

	}

	   // subit tag
	submitButton(name, obj){
		const safeName = escapeHTML(String(name));

		let submitButton = `<button type="submit" name="${safeName}"`;

		for (const [key, value] of Object.entries(obj || {})) {
			const safeKey = escapeHTML(String(key));
			const safeValue = escapeHTML(String(value));
			submitButton += ` ${safeKey}="${safeValue}"`;
		}

		submitButton += `>${safeName}</button>`;

		return submitButton;

	}

	   // search tag
	searchField(name, obj){
		const safeName = escapeHTML(String(name));

		let searchField = `<input type="search" name="${safeName}"`;

		for (const [key, value] of Object.entries(obj || {})) {
			const safeKey = escapeHTML(String(key));
			const safeValue = escapeHTML(String(value));
			searchField += ` ${safeKey}="${safeValue}"`;
		}

		searchField += '/>';

		return searchField;
	}

	   // telephone field tag
	telephoneField(name, obj){
		const safeName = escapeHTML(String(name));

		let telephoneField = `<input type="tel" name="${safeName}"`;

		for (const [key, value] of Object.entries(obj || {})) {
			const safeKey = escapeHTML(String(key));
			const safeValue = escapeHTML(String(value));
			telephoneField += ` ${safeKey}="${safeValue}"`;
		}

		telephoneField += '/>';

		return telephoneField;

	}

	   // date field tag
	dateField(name, obj){
		const safeName = escapeHTML(String(name));

		let dateField = `<input type="date" name="${safeName}"`;

		for (const [key, value] of Object.entries(obj || {})) {
			const safeKey = escapeHTML(String(key));
			const safeValue = escapeHTML(String(value));
			dateField += ` ${safeKey}="${safeValue}"`;
		}

		dateField += '/>';

		return dateField;
	}

	   // date time local field tag
	datetimeLocalField(name, obj){
		const safeName = escapeHTML(String(name));

		let datetimeLocalField = `<input type="datetime-local" name="${safeName}"`;

		for (const [key, value] of Object.entries(obj || {})) {
			const safeKey = escapeHTML(String(key));
			const safeValue = escapeHTML(String(value));
			datetimeLocalField += ` ${safeKey}="${safeValue}"`;
		}

		datetimeLocalField += '/>';

		return datetimeLocalField;
	}

	   // date month field tag
	monthField(name, obj){
		const safeName = escapeHTML(String(name));

		let monthField = `<input type="month" name="${safeName}"`;

		for (const [key, value] of Object.entries(obj || {})) {
			const safeKey = escapeHTML(String(key));
			const safeValue = escapeHTML(String(value));
			monthField += ` ${safeKey}="${safeValue}"`;
		}

		monthField += '/>';

		return monthField;
	}

	   // date week field tag
	weekField(name, obj){
		const safeName = escapeHTML(String(name));

		let weekField = `<input type="week" name="${safeName}"`;

		for (const [key, value] of Object.entries(obj || {})) {
			const safeKey = escapeHTML(String(key));
			const safeValue = escapeHTML(String(value));
			weekField += ` ${safeKey}="${safeValue}"`;
		}

		weekField += '/>';

		return weekField;
	}

	   // date url field tag
	urlField(name, obj){
		const safeName = escapeHTML(String(name));

		let urlField = `<input type="url" name="${safeName}"`;

		for (const [key, value] of Object.entries(obj || {})) {
			const safeKey = escapeHTML(String(key));
			const safeValue = escapeHTML(String(value));
			urlField += ` ${safeKey}="${safeValue}"`;
		}

		urlField += '/>';

		return urlField;
	}


	   // date email field tag
	emailField(name, obj){
		const safeName = escapeHTML(String(name));

		let emailField = `<input type="email" name="${safeName}"`;

		for (const [key, value] of Object.entries(obj || {})) {
			const safeKey = escapeHTML(String(key));
			const safeValue = escapeHTML(String(value));
			emailField += ` ${safeKey}="${safeValue}"`;
		}

		emailField += '/>';

		return emailField;
	}

	   // date color field tag
	colorField(name, color,  obj){
		const safeName = escapeHTML(String(name));
		const safeColor = escapeHTML(String(color));

		let colorField = `<input type="color" name="${safeName}" value="${safeColor}"`;

		for (const [key, value] of Object.entries(obj || {})) {
			const safeKey = escapeHTML(String(key));
			const safeValue = escapeHTML(String(value));
			colorField += ` ${safeKey}="${safeValue}"`;
		}

		colorField += '/>';

		return colorField;
	}

	   // date time field tag
	timeField(name, obj){
		const safeName = escapeHTML(String(name));

		let timeField = `<input type="time" name="${safeName}"`;

		for (const [key, value] of Object.entries(obj || {})) {
			const safeKey = escapeHTML(String(key));
			const safeValue = escapeHTML(String(value));
			timeField += ` ${safeKey}="${safeValue}"`;
		}

		timeField += '/>';

		return timeField;
	}

	   // date number field tag
	numberField(name, min, max, step, obj){
		const safeName = escapeHTML(String(name));
		const safeMin = escapeHTML(String(min));
		const safeMax = escapeHTML(String(max));
		const safeStep = escapeHTML(String(step));

		let numberField = `<input type="number" name="${safeName}" min="${safeMin}" max="${safeMax}" step="${safeStep}"`;

		for (const [key, value] of Object.entries(obj || {})) {
			const safeKey = escapeHTML(String(key));
			const safeValue = escapeHTML(String(value));
			numberField += ` ${safeKey}="${safeValue}"`;
		}

		numberField += '/>';

		return numberField;
	}

	   // date range field tag
	rangeField(name, min, max, obj){
		const safeName = escapeHTML(String(name));
		const safeMin = escapeHTML(String(min));
		const safeMax = escapeHTML(String(max));

		let rangeField = `<input type="range" name="${safeName}" min="${safeMin}" max="${safeMax}"`;

		for (const [key, value] of Object.entries(obj || {})) {
			const safeKey = escapeHTML(String(key));
			const safeValue = escapeHTML(String(value));
			rangeField += ` ${safeKey}="${safeValue}"`;
		}

		rangeField += '/>';

		return rangeField;
	}

	   // allows you to add data object to params
	addDataToParams(data){

		//loop through data and add it to new oobjects prototype
		if(data){
			var newObj = Object.create(data);
			newObj.prototype = newObj.__proto__;
			master.view.extend(newObj);
		}
	}

	// ==================== Security Methods ====================

	/**
	 * Sanitize user-generated HTML content
	 * Use this for any HTML that comes from user input
	 * @param {string} html - HTML content to sanitize
	 * @returns {string} - Sanitized HTML
	 */
	sanitizeHTML(html) {
		return sanitizeUserHTML(html);
	}

	/**
	 * Escape HTML special characters
	 * Use this to display user input as text (not HTML)
	 * @param {string} text - Text to escape
	 * @returns {string} - Escaped text safe for display
	 */
	escapeHTML(text) {
		return escapeHTML(text);
	}

	/**
	 * Render user content safely
	 * Sanitizes HTML and wraps in container
	 * @param {string} content - User-generated content
	 * @param {string} containerTag - HTML tag to wrap content (default: div)
	 * @param {object} attrs - Attributes for container
	 * @returns {string} - Safe HTML
	 */
	renderUserContent(content, containerTag = 'div', attrs = {}) {
		const sanitized = sanitizeUserHTML(content);

		let attrStr = '';
		for (const [key, value] of Object.entries(attrs)) {
			attrStr += ` ${key}="${escapeHTML(String(value))}"`;
		}

		return `<${containerTag}${attrStr}>${sanitized}</${containerTag}>`;
	}

	/**
	 * Create safe text node content
	 * @param {string} text - Text content
	 * @returns {string} - HTML-escaped text
	 */
	textNode(text) {
		return escapeHTML(text);
	}

	/**
	 * Create safe attribute value
	 * @param {string} value - Attribute value
	 * @returns {string} - Escaped and quoted value
	 */
	safeAttr(value) {
		return `"${escapeHTML(String(value))}"`;
	}

}

master.extendView("html", html);

