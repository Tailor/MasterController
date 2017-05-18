# MasterController



## DOCUMENTATION FOR MASTER CONTROL 

### APP Start:
 var app = MasterController();
 
### Declare application
 app.MasterRouter.(MasterControlFunction, function(){ // CallBack Function });

### Must Delare a Route
app.MasterRouter.(MasterControlFunction, function(){ // CallBack Function }).route();

### Must select Framework Type
 app.MasterRouter.(MasterControlFunction, function(){ // CallBack Function }).route().dom();
 app.MasterRouter.(MasterControlFunction, function(){ // CallBack Function }).route().uri();
 app.MasterRouter.(MasterControlFunction, function(){ // CallBack Function }).route().node();
 
### Declare a Controller
EXAMPLE:
app.controller('ControllerName', function (action, scope) {});

### Declare a Action -- add type like get or post
EXAMPLE:
app.action('actionName', 'type', function (scope) {});

### Calling any controller at anytime using the name
EXAMPLE:
app.callController(controllerName, scope);

### Calling any action at anytime using the action name and controller name
EXAMPLE:
app.callAction(actionName, type, scope);

## ROUTING EXAMPLES

*********  Framework will only call 1 controller and 1 action per page. Can call unlimited modules
*********  Action Name will defualt to "index" if non is provided
*********  Controller Name will default to "root"
*********  Must declare at lease one route for the root url
*********  You can delare a route without a method type like get
*********  This version is compatible with Node.js

### Declare routes
MasterRouter.route("root", "/home/index", "get");

## HTML ROUTING EXPLAINED
### RULES:
1. Only one controller per page
2. Only one action per page
3. unlimited modules per page
4. every page must have a controller and an action

### Declaritive Syntex
masterControl.MasterRouter().route(controllerName, actionName).uri(true);
masterControl.MasterRouter().route(controllerName, actionName).dom(true);
masterControl.MasterRouter().route(controllerName, actionName).node(true);

### ROUTING IN HTML
#### Declare Controller in HTML
    fan-controller="controllerName"
#### HTML Syntex
<body fan-controller="drake">
</body>

### URL ROUTING EXAMPLES

#### URL Syntext
 myapp.com/controllerName/actionName
 
#### URL Syntax Hash routing
myapp.com/#/controllerName/ActionName

#### Rules
  ******* TO USE URL HASHING YOU MUST SET URL TO TRUE
    masterControl.MasterRouter().route(controllerName, actionName).url(true);
