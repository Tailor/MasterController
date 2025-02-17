// version 0.0.23

var master = require('./MasterControl');
var fs = require('fs');
var tempClass =  require('./MasterTemplate');
var toolClass =  require('./MasterTools');
var temp = new tempClass();
var tools = new toolClass();

class html {

	javaScriptSerializer(name, obj){
		return `<script type="text/javascript">
			${name} = ${JSON.stringify(obj)}
		</script>`;
	}

	// render partial views
	renderPartial(path, data){
		

		var partialViewUrl = `/app/views/${path}`;
		var filepartialView = fs.readFileSync(master.router.currentRoute.root + partialViewUrl, 'utf8');

		var partialView = null;
		if(master.overwrite.isTemplate){
			partialView = master.overwrite.templateRender(data, "renderPartialView");
		}
		else{
			partialView =  temp.htmlBuilder(filepartialView, data);	
		}

		return partialView;

	}

	   // render all your link tags styles given the folder location
	   renderStyles(folderName, typeArray){
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
		return'<a href=' + location + '>' + name + '</a>';
	}

	   // return image tag
	imgTag(alt, location){
		return '<img src=' + location + ' alt='+ alt +'>';
	}

	   // return text are tag
	textAreaTag(name, message, obj){
		
		var textArea = "<textarea name='" + name + "'";
		for (var key in obj) {
			if (obj.hasOwnProperty(key)) {
				textArea = textArea + " " + key + "=" + "'" + obj[key] + "'";
			}
		};

		textArea = textArea + "/>" + message + "</textarea>";

		return textArea;
	}

	   // form element builder starter
	formTag(location, obj){
		var form = "<form action='" + location + "'" ;

		for (var key in obj) {
			if (obj.hasOwnProperty(key)) {
				form = form + " " + key + "=" + "'" + obj[key] + "'";
			}
		};

		return form + ">";
	}

	   // form element builder ender
	formTagEnd(){
		return '</form>';
	}
		   // return text tag
	passwordFieldTag(name, obj){
		var passwordField = "<input type='password' name='" + name + "'";

		for (var key in obj) {
			if (obj.hasOwnProperty(key)) {
				passwordField = passwordField + " " + key + "=" + "'" + obj[key] + "'";
			}
		};
		passwordField = passwordField + '/>';

		return passwordField;
	}
	   
	   // return password field tag
	textFieldTag(name, obj){
		var textField = "<input type='text' name='" + name + "'";

		for (var key in obj) {
			if (obj.hasOwnProperty(key)) {
				textField = textField + " " + key + "=" + "'" + obj[key] + "'";
			}
		};
		textField = textField + '/>';
		return textField;
	   };

	   // hidden field tag
	hiddenFieldTag(name, value, obj){
		
		var hiddenField = "<input type='hidden' name='" + name + "' value='" + value + "'";

		for (var key in obj) {
			if (obj.hasOwnProperty(key)) {
				hiddenField = hiddenField + " " + key + "=" + "'" + obj[key] + "'";
			}
		};
		hiddenField = hiddenField + '/>';
		
		return hiddenField;

	}

	   // subit tag
	submitButton(name, obj){
		
		var submitButton = "<button type='submit' name='" + name + "'";

		for (var key in obj) {
			if (obj.hasOwnProperty(key)) {
				submitButton = submitButton + " " + key + "=" + "'" + obj[key] + "'";
			}
		};

		submitButton = submitButton + ">" + name  +'</button>';
		
		return submitButton;

	}

	   // search tag
	searchField(name, obj){
		
		var searchField = "<input type='search' name='" + name + "'";

		for (var key in obj) {
			if (obj.hasOwnProperty(key)) {
				searchField = searchField + " " + key + "=" + "'" + obj[key] + "'";
			}
		};
		searchField = searchField + '/>';
		
		return searchField;
	}

	   // telephone field tag
	telephoneField(name, obj){

		var telephoneField = "<input type='tel' name='" + name + "'";

		for (var key in obj) {
			if (obj.hasOwnProperty(key)) {
				telephoneField = telephoneField + " " + key + "=" + "'" + obj[key] + "'";
			}
		};
		telephoneField = telephoneField + '/>';

		return telephoneField;

	}

	   // date field tag
	dateField(name, obj){

		var dateField = "<input type='date' name='" + name + "'";

		for (var key in obj) {
			if (obj.hasOwnProperty(key)) {
				dateField = dateField + " " + key + "=" + "'" + obj[key] + "'";
			}
		};
		dateField = dateField + '/>';

		return dateField;
	}

	   // date time local field tag
	datetimeLocalField(name, obj){

		var datetimeLocalField = "<input type='datetime-local' name='" + name + "' ";

		for (var key in obj) {
			if (obj.hasOwnProperty(key)) {
				datetimeLocalField = datetimeLocalField + " " + key + "=" + "'" + obj[key] + "'";
			}
		};
		datetimeLocalField = datetimeLocalField + '/>';

		return datetimeLocalField;
	}

	   // date month field tag
	monthField(name, obj){

		var monthField = "<input type='month' name='" + name + "' ";

		for (var key in obj) {
			if (obj.hasOwnProperty(key)) {
				monthField = monthField + " " + key + "=" + "'" + obj[key] + "'";
			}
		};
		monthField = monthField + '/>';

		return monthField;
	}

	   // date week field tag
	weekField(name, obj){

		var weekField = "<input type='week' name='" + name + "' ";

		for (var key in obj) {
			if (obj.hasOwnProperty(key)) {
				weekField = weekField + " " + key + "=" + "'" + obj[key] + "'";
			}
		};
		weekField = weekField + '/>';
		
		return weekField;
	}

	   // date url field tag
	urlField(name, obj){
		
		var urlField = "<input type='url' name='" + name + "' ";

		for (var key in obj) {
			if (obj.hasOwnProperty(key)) {
				urlField = urlField + " " + key + "=" + "'" + obj[key] + "'";
			}
		};
		urlField = urlField + '/>';

		return urlField;
	}


	   // date email field tag
	emailField(name, obj){
		
		var emailField = "<input type='email' name='" + name + "' ";

		for (var key in obj) {
			if (obj.hasOwnProperty(key)) {
				emailField = emailField + " " + key + "=" + "'" + obj[key] + "'";
			}
		};
		emailField = emailField + '/>';

		return emailField;
	}

	   // date color field tag
	colorField(name, color,  obj){
		
		var colorField = "<input type='color' name='" + name + "' value='" + color + "'";

		for (var key in obj) {
			if (obj.hasOwnProperty(key)) {
				colorField = colorField + " " + key + "=" + "'" + obj[key] + "'";
			}
		};
		colorField = colorField + '/>';

		return colorField;
	}

	   // date time field tag
	timeField(name, obj){
		
		var timeField = "<input type='time' name='" + name + "' ";

		for (var key in obj) {
			if (obj.hasOwnProperty(key)) {
				timeField = timeField + " " + key + "=" + "'" + obj[key] + "'";
			}
		};
		timeField = timeField + '/>';

		return timeField;
	}

	   // date number field tag
	numberField(name, min, max, step, obj){
		
		var numberField = "<input type='number' name='" + name + "'" + " min='" +  min + "'" + " max='" + max + "'" + " step='" + step + "'";

		for (var key in obj) {
			if (obj.hasOwnProperty(key)) {
				numberField = numberField + " " + key + "=" + "'" + obj[key] + "'";
			}
		};
		numberField = numberField + '/>';

		return numberField;
	}

	   // date range field tag
	rangeField(name, min, max, obj){

		var rangeField = "<input type='range' name='" + name + "'" + " min='" +  min + "'" + " max='" + max + "'";

		for (var key in obj) {
			if (obj.hasOwnProperty(key)) {
				rangeField = rangeField + " " + key + "=" + "'" + obj[key] + "'";
			}
		};
		rangeField = rangeField + '/>';
		
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
	
}

master.extendView("html", html);

