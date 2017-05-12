# MasterController



## DOCUMENTATION FOR MASTER CONTROL 

### APP Start:
 var app = MasterController();

### Declare a Controller
EXAMPLE:
app.controller('ControllerName', function (action, scope) {});

### Declare a Action -- add type like get or post
EXAMPLE:
app.action('actionName', 'controllerName', function (scope) {});

### Declare a Module
EXAMPLE:
app.module( 'moduleName', 'actionName', 'controllerName', function (scope) {});

### Calling any controller at anytime using the name
EXAMPLE:
app.callController(controllerName, scope);

### Calling any action at anytime using the action name and controller name
EXAMPLE:
app.callAction(actionName, controllerName, scope);

### Calling any module at anytime using the module name and action name and controller name
EXAMPLE:
app.callModule( moduleName,  actionName, controllerName, scope);

## ROUTING EXAMPLES

*********  Framework will only call 1 controller and 1 action per page. Can call unlimited modules
*********  Action Name will defualt to "index" if non is provided
*********  Controller Name will default to "root"
*********  Must declare at lease one route for the root url
*********  You can delare a route without a method type like get
*********  This version is compatible with Node.js

### Declare application
MasterRouter.(MasterControlFunction, function(){ // CallBack Function });

### Declare routes
MasterRouter.route("root", "/home/index", "get");

## HTML ROUTING EXPLAINED
### RULES:
1. Only one controller per page
2. Only one action per page
3. unlimited modules per page
4. every page must have a controller and an action

### HTML Syntex
<body fan-controller="drake">
    <div fan-action="index">
        <div fan-module="content">
            The content of the document......
        </div>
    </div>
</body>

### Declaritive Syntex
masterControl.MasterRouter().route(controllerName, actionName).url(true);
masterControl.MasterRouter().route(controllerName, actionName).html(true);
masterControl.MasterRouter().route(controllerName, actionName).node(true);

### ROUTING IN HTML
#### Declare Controller in HTML
    fan-controller="controllerName"
#### Declare Action in HTML
    fan-action="actionName"
#### Declare Module in HTML 
    fan-module-"moduleName"

### URL ROUTING EXAMPLES

#### URL Syntext
 myapp.com/controllerName/actionName
 
#### URL Syntax Hash routing
myapp.com/#/controllerName/ActionName

#### Rules
  ******* TO USE URL HASHING YOU MUST SET URL TO TRUE
    masterControl.MasterRouter().route(controllerName, actionName).url(true);
