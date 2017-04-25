// MasterControl - by Alexander Batista - Tailer 2016 - MIT Licensed 
// version 1.10

var MasterControl = (function (window, undefined) {

    // keeps the list of controller that need to be called
    var $$appSelector;
    var $$moduleObserverOn = true;
    var $$appScope;
    var $$controllerList = [];
    var $$actionList = [];
    var $$moduleList = [];
    var $$DOMSnapShot = [];

    var _init = function (appName, func, options) {

        options = options || {};
        if(options.moduleObserver === false){
            $$moduleObserverOn = false;
        }
        // when page loads
        window.addEventListener('load', function (){

            //look for main app controller 
            $$appSelector = "[fan-app='" + appName + "']";
            $$appScope = document.querySelector($$appSelector);

            // call the module method function
            func($$appScope);

            // setup the DOM SnapShot
            _setupWatcher($$appScope);
        });

    };

    var _setupWatcher = function(appScope){

            // clear snapshot
            _clearSnapShot();
            // select all controllers inside of the main app
            var controllerArray = appScope.querySelectorAll("[fan-controller]");

            // check that we find a controller declaration inside the app declaration
            if (controllerArray.length > 0) {

                // loop through all controllers found inside the main app
                for (var i = 0; i < controllerArray.length; i++) {

                        var controllerWatcher = _createSnapShot(controllerArray[i]);

                        // send the controller to watch
                        $$DOMSnapShot.push(controllerWatcher);

                        // wait for last loop to call digest html
                        if (i == controllerArray.length - 1) {
                            _digestSnapShot();
                        }
                }

            }
            else{
                // cannot find any controllers on page
                console && console.log("no controller found");
            }

    };

    var _clearSnapShot = function(){
            $$DOMSnapShot = [];
    };

    var _createSnapShot = function(controllerArray){

            var controllerName = controllerArray.getAttribute("fan-controller");
            
            // find actions inside the controller declaration
            var actionArray = controllerArray.querySelectorAll("[fan-action]");

            // create a controller engine 
            var controllerWatcher = {
                controllerName: controllerName,
                controllerScope: controllerArray, // scope is the html of the containing declaration
                actions : []
            };


            if (actionArray.length > 0) {

                for (var r = 0; r < actionArray.length; r++) {

                        var actionName = actionArray[r].getAttribute("fan-action");
                        // loop through fan actions 
                        var moduleArray = actionArray[r].querySelectorAll("[fan-module]");

                        if($$moduleObserverOn === true){
                             _moduleObserver(controllerName, actionName, controllerArray );
                        }

                        // create a action engine 
                        var actionWatcher = {
                            actionName: actionName,
                            actionScope: actionArray[r],
                            modules : [] // scope is the html of the containing declaration
                        };

                        if (moduleArray.length > 0) {

                            for (var p = 0; p < moduleArray.length; p++) {

                                var moduleName = moduleArray[p].getAttribute("fan-module");

                                    // create a action engine 
                                    var moduleWatcher = {
                                        moduleName: moduleName,
                                        moduleScope: moduleArray[r] // scope is the html of the containing declaration
                                    };

                                    // push to action array inside the action watch
                                    actionWatcher.modules.push(moduleWatcher);
                            }

                        }

                        // push to action array inside the controller watch
                        controllerWatcher.actions.push(actionWatcher);
                }

            }
    

            return controllerWatcher;
    };

    var _moduleObserver = function(controllerName, actionName, observer){

            // when something new get added to the page
            var elementObserver = new MutationObserver(function(e){

                if(e[0] !== undefined){
                    var html = e[0].target;
                    // grab all fan modules inside html that was just added
                    var moduleArrays = html.querySelectorAll("[fan-module]");

                    for (var ch = 0; ch < moduleArrays.length; ch++) {
                         var moduleName = moduleArrays[ch].getAttribute("fan-module");
                         _call_module(controllerName, actionName, moduleName, moduleArrays[ch]);
                    }
                }
            });

            elementObserver.observe(observer, { childList: true, subtree: true });
    };


    // loops through watch array and calls every function
    var _digestSnapShot = function () {

        var controllerCalled = false;
        var actionCalled = false;
        var moduleCalled = false;

        // loop through all controllers html delcarations
        // loop throuh all the different controllers
        for (var i = 0; i < $$DOMSnapShot.length; i++) {
        
            // loop through all controller function declarations to find matches with DOMSNAPSHOT
            $$controllerList.forEach(function (callback, index) {

                // before we look for a match lets clean up the controller name
                var controllerNameSplit = callback.controllerName.split(":");
                var controllerName = controllerNameSplit[0];

                // only call the declarations that match
                if (controllerName === $$DOMSnapShot[i].controllerName) {

                    controllerCalled = true;

                    // add the call back function to DOMSnapShot for later use
                    $$DOMSnapShot[i].callback = callback;

                    // call the controller
                    //$$DOMSnapShot[i].callback.aFunction($$DOMSnapShot[i].controllerScope);
                    _call_controller(controllerName, $$DOMSnapShot[i].controllerScope);

                    //loop through html actions inside of controllers
                    for (var p = 0; p < $$DOMSnapShot[i].actions.length; p++) {

                        var outerAction = $$DOMSnapShot[i].actions[p];

                        // loop through action function list
                        $$actionList.forEach(function (actionCallBack) {

                            if (actionCallBack.controllerName === $$DOMSnapShot[i].controllerName && actionCallBack.actionName === $$DOMSnapShot[i].actions[p].actionName) {
                                actionCalled = true;
                                // add call back to snapshot
                                $$DOMSnapShot[i].actions[p].callback = actionCallBack;
                                _call_action(actionCallBack.controllerName, actionCallBack.actionName, outerAction.actionScope);
                                //$$DOMSnapShot[i].actions[p].callback.aFunction(outerAction.actionScope);

                                 // loop inside actions for modules
                                for (var m = 0; m < outerAction.modules.length; m++) {

                                        var outerModule = outerAction.modules[m];

                                        // loop through action function list
                                        $$moduleList.forEach(function (moduleCallBack) {

                                            if (moduleCallBack.moduleName === outerModule.moduleName && moduleCallBack.controllerName === $$DOMSnapShot[i].controllerName && moduleCallBack.actionName === $$DOMSnapShot[i].actions[p].actionName) {
                                                moduleCalled = true;

                                                // add call back to snapshot
                                                $$DOMSnapShot[i].actions[p].modules[m].callback = moduleCallBack;
                                                _call_module(moduleCallBack.controllerName, moduleCallBack.actionName, moduleCallBack.moduleName, outerAction.moduleScope);
                                            }

                                        });

                                        // if action counter is 0 then it did not find action controller with html name
                                        if (moduleCalled === false) {
                                            var errorMessage = "Error could not find any function module declaration with name " + $$DOMSnapShot[i].actions[p].module[m].moduleName + " for action " + $$DOMSnapShot[i].actions[p].actionName;
                                            throw new Error(errorMessage);
                                        }

                                 };



                            }

                        });


                        // if action counter is 0 then it did not find action controller with html name
                        if (actionCalled === false) {
                            var errorMessage = "Error could not find any function action declaration with name " + $$DOMSnapShot[i].actions[p].actionName + " for controller " + $$DOMSnapShot[i].controllerName;
                            throw new Error(errorMessage);
                        }

                    }


                }

            });

            // if controller counter is 0 then it did not find function controller with html name
            if (controllerCalled === false) {
                var errorMessage = "Error could not find any function controller declaration with name " + $$DOMSnapShot[i].controllerName;
                throw new Error(errorMessage);
            }
        }

        //clear the array
        _clearSnapShot();
    };

    var _refreshDOM = function(){

        // re-load everything
        _setupWatcher($$appScope);
    };


    var _call_controller = function (controllerName, scope) {

            if(controllerName){

                   var counter = 0;

                    // loop through all the controller that were loaded 
                    if ($$controllerList.length > 0) {
                        // call an anonymous function that has object
                        $$controllerList.forEach(function (callback) {
                            // only call the ones that we find in the DOM
                            if (callback.controllerName === controllerName) {
                                counter++;
                                callback.aFunction(scope);
                            }
                        });

                        // if couter is 0 then it did not find controller for attribute
                        if (counter === 0) {
                            var errorMessage = "Error could not find controller with name " + controllerName;
                            return errorMessage;
                        }

                        return null
                    }
                    else {
                        var errorMessage = "Error could not find any controller";
                        return errorMessage;
                    }
                }
    };

    var _call_action = function (controllerName, actionName, scope) {

            if(actionName && controllerName){

                var counter = 0;

                // loop through all the actions that were loaded 
                if ($$actionList.length > 0) {

                    for(var b = 0; $$actionList.length > b; b++){

                        var actionNameLowercase = $$actionList[b].actionName.toLowerCase();
                        var controllerNameLowercase = $$actionList[b].controllerName.toLowerCase();
                        var actionName = actionName.toLowerCase();
                        var controllerName = controllerName.toLowerCase();

                        if(actionNameLowercase === actionName){
                            // only call the ones that we find in the DOM
                            if (actionNameLowercase === actionName && controllerNameLowercase == controllerName) {
                                counter++;
                                $$actionList[b].aFunction(scope);
                            }
                        }

                    }

                    // if couter is 0 then it did not find controller for attribute
                    if (counter === 0) {
                        var errorMessage = "Error could not find action with name " + actionName;
                        return errorMessage;
                    }

                    return null
                }
                else {
                    var errorMessage = "Error could not find any action";
                    return errorMessage;
                }
            }
    };

    var _call_module = function (controllerName, actionName, moduleName, scope) {

            if(controllerName && actionName && moduleName){

                var counter = 0;

                // loop through all the actions that were loaded 
                if ($$moduleList.length > 0) {

                    for(var m = 0; $$moduleList.length > m; m++){

                        var actionNameLowercase = $$moduleList[m].actionName.toLowerCase();
                        var moduleNameLowercase = $$moduleList[m].moduleName.toLowerCase();
                        var controllerNameLowercase = $$moduleList[m].controllerName.toLowerCase();

                        var actionName = actionName.toLowerCase();
                         var moduleName = moduleName.toLowerCase();
                        var controllerName = controllerName.toLowerCase();

                        if(moduleNameLowercase === moduleName){
                            // only call the ones that we find in the DOM
                            if (actionNameLowercase === actionName && controllerNameLowercase == controllerName) {
                                counter++;
                                $$moduleList[m].aFunction(scope);
                            }
                        }

                    }

                    // if couter is 0 then it did not find controller for attribute
                    if (counter === 0) {
                        var errorMessage = "Error could not find module with name " + moduleName;
                        return errorMessage;
                    }

                    return null
                }
                else {
                    var errorMessage = "Error could not find any module";
                    return errorMessage;
                }
            }

    };


    // return only the api that we want to use
    return {
            // will refresh DOM
            refresh:function(){
                _refreshDOM();
            },

            // call controller using name
            callController : function(controllerName, scope){
                var returnController = _call_controller(controllerName, scope);
                return returnController;
            },

            // call action using name
            callAction : function(controllerName, actionName, scope){

                var returnAction = _call_action(controllerName, actionName, scope);
                return returnAction;
            },


            // call action using name
            callModule : function(controllerName, actionName, moduleName, scope){

                var returnModule = _call_module(controllerName, actionName, moduleName, scope);
                return returnModule;
            },
            
            start : function(appName, func, options){
                // calling inner fucntion
                _init(appName, func, options);
                return this;
            },

            // this gets called by the declairation of the function on the page
            controller : function (controllerName, aFunction) {
                // this will push an object into array
                var objectController = {
                    controllerName: controllerName,
                    aFunction: aFunction
                };

                $$controllerList.push(objectController);
                return this;
            },

            // this gets called by the declairation of the function on the page
            action : function (controllerName, actionName, aFunction) {
                // this will push an object into array
                var objectAction = {
                    controllerName: controllerName,
                    actionName: actionName,
                    aFunction: aFunction
                };

                $$actionList.push(objectAction);
                return this;
            },

            // this gets called by the declairation of the function on the page
            module : function (controllerName, actionName, moduleName, aFunction) {
                // this will push an object into array
                var objectModule = {
                    controllerName: controllerName,
                    actionName: actionName,
                    moduleName: moduleName,
                    aFunction: aFunction
                };

                $$moduleList.push(objectModule);
                return this;
            }


    };
})(window);

/********************************************************************************************************************************/
/************************************************ DOCUMENTATION FOR MASTER CONTROL **********************************************/
/********************************************************************************************************************************/

// load the Application
// var app = MasterControl;

// declare the Application
// app.start("nameofApp", function(scope){});

// declare Application in html
// fan-app="nameofapp"

// declare a Controller
// EXAMPLE:
// AdminApp.controller('name', function (action, scope) {});

// declare a Controller in HTML
// EXAMPLE:
// fan-controller='name'

// declare a Action
// EXAMPLE:
// AdminApp.action('controllerName', name', function (scope) {});

// declare a Action in HTML inside of controller
// EXAMPLE:
// fan-action='name'

// declare a Module
// EXAMPLE:
// AdminApp.module('controllerName', 'actionName', 'name', function (scope) {});

// declare a Module in HTML inside of controller
// EXAMPLE:
// fan-module='name'

// ****** Module Observer allows you to listen and automaticlly call modules that are adding to the DOM dynamiclly
// ****** Module Observer can make master controller slower so there is an option to turn it off

// To turn off module observer just set moduleObserver to false inside the options Parameters;
// EXAMPLE:
// options = { moduleObserver: false}
// app.start(appname, func, options)

// refreshING the DOM recalls everything on the page
// EXAMPLE:
// AdminApp.refresh();

// calling any controller at anytime using the name
// EXAMPLE:
// AdminApp.callController(controllerName);

// calling any action at anytime using the action name and controller name
// EXAMPLE:
// AdminApp.callAction(controllerName, actionName);

// calling any module at anytime using the module name and action name and controller name
// EXAMPLE:
// AdminApp.callModule(controllerName, actionName, moduleName);


// ========================================================================================================================
// ============================================// version 2 ideas \\ ===================================================
// ========================================================================================================================

// 1. Services
// add a way like jquery to easily hook into functions to access them without having to set global functions
// for example lets say I create a module for a navigation property 
// and now I need a service to help manage that navigation property
// To do this I would have to create it in jquery and add it as a plugin
// if we do this without our application then we dont need to use jquery


// 2. TEMPLATING 
// AdminApp.module('controllerName', 'actionName', name', function (scope) {

    // var linkTag = AdminApp.createElement(
    //     '<a href="#" class="plus-link-circle" >'
    //     , AdminApp.createElement('span', '+')
    // );

//});

// This would spit out
// <a href="#" class="plus-link-circle" >
//     <span>+</span>
// </a>
