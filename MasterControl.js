// MasterControl - by Alexander Batista - Tailer 2017 - MIT Licensed 
// version 1.14 -- node compatiable


( function( global, factory ) {

    "use strict";

    if ( typeof module === "object" && typeof module.exports === "object" ) {
        module.exports = factory( global );
    } else {
        factory( global );
    }

// Pass this if window is not defined yet
} )( typeof window !== "undefined" ? window : this, function( window, noGlobal ) {

    var $$controllerList = [];
    var $$actionList = [];
    var $$moduleList = [];
    var $$currentControllerName;
    var $$currentActionName;

    var _call_controller = function (controllerName, scope) {
            $$currentControllerName = controllerName;

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
                            throw new Error( "Error could not find controller with name " + controllerName);
                        }

                        return null
                    }
                    else {
                        throw new Error( "Error could not find any controller");
                    }
                }
    };

    var _call_action = function (actionName, controllerName, scope) {

            $$currentActionName =  actionName;
            
            if(actionName && controllerName){

                var counter = false;

                // loop through all the actions that were loaded
                if ($$actionList.length > 0) {

                    for(var b = 0; $$actionList.length > b; b++){

                        var actionNameLowercase = $$actionList[b].actionName.toLowerCase();
                        var controllerNameLowercase = $$actionList[b].controllerName.toLowerCase();
                            

                        var actionName = actionName.toLowerCase();
                        var controllerName = controllerName.toLowerCase();

                        if(actionNameLowercase === actionName){

                            if (actionNameLowercase === actionName && controllerNameLowercase == controllerName) {
                                $$actionList[b].aFunction(scope);
                                counter = true;
                            }
                            else{
                                throw new Error( "cannot find action " + actionNameLowercase );
                            }
                        }

                    }

                    // if couter is 0 then it did not find controller for attribute
                    if (counter === false) {
                        throw new Error( "Error could not find action with name " + actionName);
                    }

                    return null
                }
                else {
                    throw new Error( "Error could not find any action");
                }
            }
    };

    var _call_module = function (moduleName, actionName, controllerName, scope) {

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
                        throw new Error( "Error could not find module with name " + moduleName);
                    }

                    return null
                }
                else {
                    throw new Error( "Error could not find any module");
                }
            }

    };

    var MasterController = function() {

        return MasterController.fn;
    };

    // return only the api that we want to use
    MasterController.fn = MasterController.prototype = {

            // call controller using name
            callController : function(controllerName, scope){
                var returnController = _call_controller(controllerName, scope);
                return returnController;
            },

            // call action using name
            callAction : function(actionName, controllerName, scope){

                var returnAction = _call_action(actionName, controllerName, scope);
                return returnAction;
            },


            // call action using name
            callModule : function( moduleName, actionName, controllerName, scope){

                var returnModule = _call_module(moduleName, actionName, controllerName, scope);
                return returnModule;
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
            action : function (actionName, controllerName,  aFunction) {

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
            module : function (moduleName, actionName, controllerName, aFunction) {
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

    if ( typeof define === "function" && define.amd ) {
        define( "mastercontroller", [], function() {
            return MasterController;
        });
    }

    var _MasterController = window.MasterController;


    MasterController.noConflict = function( deep ) {

        if ( deep && window.MasterController === MasterController ) {
            window.MasterController = _MasterController;
        }

        return MasterController;
    };

    if ( !noGlobal ) {
        window.MasterController = MasterController;
    };

    return MasterController;

});



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

