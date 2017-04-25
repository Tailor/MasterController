// MasterRouterHTML - Alexander Batista - MIT Licensed - Tailr.net
// version 1.3
// A simple routing framework that makes it fun and easy to control routing modules using HTML attributes

( function( global, factory ) {

    "use strict";

    if ( typeof module === "object" && typeof module.exports === "object" ) {

        module.exports = global.document ?
            factory( global, true ) :
            function( w ) {
                if ( !w.document ) {
                    throw new Error( "Master Router requires a window with a document" );
                }
                return factory( w );
            };
    } else {
        factory( global );
    }

// Pass this if window is not defined yet
} )( typeof window !== "undefined" ? window : this, function( window, noGlobal ) {

    // keeps the list of controller that need to be called
    var _currentSnapShot;
    var _activeController;
    var _masterController;

    var _init = function (masterController, callBack) {
        
        if(masterController === null || masterController === undefined)
            throw new Error("Master Controller not found");

        _masterController = masterController;

        window.addEventListener('load', function (){

            // call the module method function
           callBack(window.document);

            // setup the DOM SnapShot
           var snap = _createSnapShot(window.document);
           if(snap !== null){
               // set snapshot as current
               _activeController = snap;
                // digest snap
                _digestSnapShot();
            }

        });
    };

    var _createSnapShot = function(module){

            // should be only one controller per page
            var controller;

            if(module !== null){
                controller = module.querySelector("[fan-controller]");
            }
            else{
                controller = document.querySelector("[fan-controller]");
            }

            // check that we find a controller declaration inside the app declaration
            if (controller !== undefined && controller !== null) {
                var controllerWatcher = _createVirtualSnapShot(controller);
                // start building DOM snapshot
                return controllerWatcher;
            }
            else{
                // cannot find any controllers 
                console && console.log("no controller found");
                return null;
            }

    };

    var _createVirtualSnapShot = function(controller){

        if(controller != null){

            var controllerName = controller.getAttribute("fan-controller");
            var HTTPRequestList = ["post", "get", "put", "patch", "delete"];

            // create a controller engine 
            var controllerWatcher = {
                controllerName: controllerName,
                controllerScope: controller, // scope is the html of the containing declaration
                actions : []
            };

            // find actions inside the controller declaration
            HTTPRequestList.forEach(function(type){

                var $actionSelector = "fan-action-"+ type;
                var $actionScope = controller.querySelector("[" + $actionSelector + "]");

                if($actionScope !== null){
                    var $moduleScopes = $actionScope.querySelectorAll("[fan-module]");

                    var action = {
                        actionScope : $actionScope,
                        actionType : type,
                        actionSelector : $actionSelector,
                        actionName:  $actionScope.getAttribute($actionSelector),
                        modules : []
                    };

                    for (var m = 0; m < $moduleScopes.length; m++) {

                            var module = {
                                moduleScope : $moduleScopes[m],
                                moduleName:  $moduleScopes[m].getAttribute("fan-module")
                            };

                         action.modules.push(module);   
                     }

                    controllerWatcher.actions.push(action);
                }
            });

            return controllerWatcher;
        }else{

            throw new Error("Cannot create Virtual SnapShot without scope controller");
        }
    };

        // loops through watch array and calls every function
    var _digestSnapShot = function () {

        if(_activeController != null){
            _call_controller(_activeController.controllerName, _activeController.controllerScope);

            // loop through all actions 
            _activeController.actions.forEach(function (actionCallBack) {

                _call_action(actionCallBack.actionType, actionCallBack.actionName, _activeController.controllerName, actionCallBack.actionScope);

                    // loop through and call modules
                actionCallBack.modules.forEach(function (moduleCallBack) {
                    _call_module(moduleCallBack.moduleName, actionCallBack.actionName, _activeController.controllerName, moduleCallBack.actionScope);

                });

            });

            //clear the array
            currentSnapShot = _activeController;
            _activeController = null;
        }else{
            throw new Error("Cannot digest current snapshot without controller scope");
        }
    };


    var _digestSnapShotChanges = function(newSnapShot, currentSnapShot){

        if(newSnapShot.controllerName === currentSnapShot.controllerName){

                // if controller has not changed then compare and check actions
                newSnapShot.actions.forEach(function (actionCallBack) {
                        var isActionFound = false;
                        // loop through current action
                        currentSnapShot.actions.forEach(function (currentActionCallBack) {
                            if(currentActionCallBack.actionName === actionCallBack.actionName && currentActionCallBack.actionType === actionCallBack.actionType){
                                // if found then dont call
                                isActionFound = true;
                            }
                            // loop through actions module
                            actionCallBack.modules.forEach(function (currentModuleCallBack) {
                                    var isModuleFound = false;
                                    // loop through current action modules
                                    currentActionCallBack.modules.forEach(function (moduleCallBack) {

                                           if(currentModuleCallBack.moduleName === moduleCallBack.moduleName){
                                              isModuleFound = true;
                                           }       

                                    });

                                    if(!isModuleFound){
                                        _call_module(currentModuleCallBack.moduleName, newSnapShot.controllerName, actionCallBack.actionName, currentModuleCallBack.actionScope);
                                    }
                            });


                            // currentAction.module loop
                            //  
                        });

                        if(!isActionFound){
                            // if action has not changed then compare and check modules
                            _call_action(actionCallBack.actionType,actionCallBack.actionName,newSnapShot.controllerName,  actionCallBack.actionScope);
                            // call all modules because new action loaded
                            actionCallBack.modules.forEach(function (moduleCallBack) { 
                                _call_module(moduleCallBack.moduleName, newSnapShot.controllerName,  actionCallBack.actionName, moduleCallBack.actionScope);
                            });

                        };

                });

        }else{        // if controllers are different then reload controller and set as active controller
            
            _call_controller(newSnapShot.controllerName, _activeController.controllerScope);
            // set snapshot as current
            _activeController = snap;
            // digest snap
            _digestSnapShot();

        }

    };

    var _refresh = function(scope){
        if(scope !== null){
                    var snap = _createSnapShot(scope);
                    _digestSnapShotChanges(snap , _currentSnapShot);
        }else{
            throw new Error("Must provide scope to refresh DOM");
        }
    };

    var _call_controller = function (controllerName, scope) {

            if (controllerName === undefined) 
                throw new Error("Cannot call Controller witout Controller name");

            _masterController.callController(controllerName, scope);

    };

    var _call_action = function (type, actionName, controllerName, scope) {

            if (actionName === undefined) 
                throw new Error("Cannot call Action witout Action name");

            _masterController.callAction(type, actionName, controllerName, scope);

    };

    var _call_module = function (moduleName, actionName, controllerName, scope) {
            if (moduleName === undefined) 
                throw new Error("Cannot call Action witout Action name");
            
            _masterController.callModule(moduleName, actionName, controllerName, scope);
    };

    var MasterRouterHTML = function(masterController, callBack) {
        _init( masterController, callBack);
        return MasterRouterHTML.fn;
    };

    // return only the api that we want to use
    MasterRouterHTML.fn = MasterRouterHTML.prototype = {
            // will refresh DOM
            refresh: function(scope){
                _refresh(scope);
            }
    };


    if ( typeof define === "function" && define.amd ) {
        define( "masterrouterhtml", [], function() {
            return MasterRouterHTML;
        });
    }

    var _MasterRouterHTML = window.MasterRouterHTML;


    MasterRouterHTML.noConflict = function( deep ) {

        if ( deep && window.MasterRouterHTML === MasterRouterHTML ) {
            window.MasterRouterHTML = _MasterRouterHTML;
        }

        return MasterRouterHTML;
    };

    if ( !noGlobal ) {
        window.MasterRouterHTML = MasterRouterHTML;
    };

    return MasterRouterHTML;

});


/********************************************************************************************************************************/
/************************************************ FRAMEWORK EXAMPLES *********************************************/
/********************************************************************************************************************************/

