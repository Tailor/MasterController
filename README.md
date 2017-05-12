# MasterController



/********************************************************************************************************************************/
/************************************************ DOCUMENTATION FOR MASTER CONTROL **********************************************/
/********************************************************************************************************************************/

// Start:
// var app = MasterController();

// declare a Controller
// EXAMPLE:
// app.controller('ControllerName', function (action, scope) {});

// declare a Action -- add type like get or post
// EXAMPLE:
// app.action('actionName', 'controllerName', function (scope) {});

// declare a Module
// EXAMPLE:
// app.module( 'moduleName', 'actionName', 'controllerName', function (scope) {});

// calling any controller at anytime using the name
// EXAMPLE:
// app.callController(controllerName, scope);

// calling any action at anytime using the action name and controller name
// EXAMPLE:
// app.callAction(actionName, controllerName, scope);

// calling any module at anytime using the module name and action name and controller name
// EXAMPLE:
// app.callModule( moduleName,  actionName, controllerName, scope);


/********************************************************************************************************************************/
/************************************************ ROUTING EXAMPLES *********************************************/
/********************************************************************************************************************************/
// *********  Framework will only call 1 controller and 1 action per page. Can call unlimited modules
// *********  Action Name will defualt to "index" if non is provided
// *********  Controller Name will default to "root"
// *********  Must declare at lease one route for the root url
// *********  You can delare a route without a method type like get
// *********  This version is compatible with Node.js

// declare application
// MasterRouter.(MasterControlFunction, function(){ // CallBack Function });

// declare routes
// MasterRouter.route("root", "/home/index", "get");


/********************************************************************************************************************************/
/************************************************ HTML ROUTING EXPLAINED *********************************************/
/********************************************************************************************************************************/

// RULES:
// Only one controller per page
// Only one action per page
// unlimited modules per page
// every page must have a controller and an action

// SYNTEX:
/*
<body fan-controller="drake">
    <div fan-action="index">
        <div fan-module="content">
            The content of the document......
        </div>
    </div>
</body>

*/

// ROUTING IN HTML:
// Declare Controller in HTML
    // fan-controller="controllerName"
// Declare Action in HTML
    // fan-action="actionName"
// Declare Module in HTML 
    // fan-module-"moduleName"

    // masterControl.MasterRouter( function(){
    //         console.log("master router call back function being called");
    //     }).route("root", "/drake/").html();

    // masterControl.MasterRouter( function(){
    //         console.log("master router call back function being called");
    //     }).route("root", "/drake/").node();

    // masterControl.MasterRouter( function(){
    //         console.log("master router call back function being called");
    //     }).route("root", "/drake/").url(true);


/********************************************************************************************************************************/
/************************************************ URL ROUTING EXAMPLES *********************************************/
/********************************************************************************************************************************/
// *********  We are using window.location to get url
// *********  We are using window.onhashchange to listen for hash changes

// URL SYNTEX:
    // myapp.com/controllerName/actionName

// URL HASHING:
    // TO USE URL HASHING MUST SET URL TO TRUE
            //MasterRouter().url(true);

    // SYTEX HASH ROUTING
        // #/controllerName/ActionName

