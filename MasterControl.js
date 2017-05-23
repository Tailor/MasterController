// MasterControl - by Alexander Batista - Tailer 2017 - MIT Licensed 
// version 1.4 - beta -- node compatiable


( function( global, factory ) {

    "use strict";

    if ( typeof module === "object" && typeof module.exports === "object" ) {
        module.exports = factory( global );
    } else {
        factory( global );
    }

// Pass this if window is not defined yet
} )( typeof window !== "undefined" ? window : this, function( window, noGlobal ) {

    // return only the api that we want to use
    var MasterController = {

            extend : function (){
                var i = arguments.length;

                while (i--) {

                    for (var m in arguments[i]) {
                        MasterController[m] = arguments[i][m];
                    }
                }
                return MasterController;
            }

    };

    // closing function
    if ( typeof define === "function" && define.amd ) {
        define( "mastercontroller", [], function() {
            return MasterController;
        });
    }

    var _MasterController = window.MasterController;

    if ( !noGlobal ) {
        window.MasterController = MasterController;
    };

});




( function( global, factory ) {

    "use strict";

    if ( typeof module === "object" && typeof module.exports === "object" ) {
        module.exports = factory( global );
    } else {
        factory( global );
    }

// Pass this if window is not defined yet
} )( typeof window !== "undefined" ? window : this, function( window, noGlobal ) {

   MasterController.extend({
            masterController : function(aFunc){
                    if(aFunc !== undefined && aFunc !== null && typeof aFunc === "function"){
                        aFunc();
                    };
            },
            // call controller using name
            call : function(options, scope){

                var controllerOptions = {
                    namespace : options.namespace,
                    name: options.name,
                    type: options.type
                };

                var returnController = MasterController.utils._call(controllerOptions, scope);
                return returnController;
            },

            // this gets called by the declairation of the function on the page
            controller : function (options, aFunction) {

                var controllerOptions = {
                    namespace : options.namespace,
                    name: options.name,
                    type: options.type,
                    func : aFunction
                };

                MasterController.utils._controllerList.push(controllerOptions);
                return this;
            }

        });

});

( function( global, factory ) {

    "use strict";

    if ( typeof module === "object" && typeof module.exports === "object" ) {
        module.exports = factory( global );
    } else {
        factory( global );
    }

// Pass this if window is not defined yet
} )( typeof window !== "undefined" ? window : this, function( window, noGlobal ) {


    MasterController.extend({

        utils : {

            _controllerList :[],
                _routeList :[],
                _controllerModal :{
                    namespace : "",
                    name: "",
                    type: "",
                    func : ""
                },
                _getNameSpaceFromURI : function(pathName){
                    const uri = pathName.replace(/^\/|\/$/g, '');
                    const uriArray = uri.split("/");

                    var controller = uriArray[0];
                    if (controller === undefined) {
                        controller = "";
                    }
                    return controller;
                },
                _getControllerFromURI : function(pathName){
                    const uri = pathName.replace(/^\/|\/$/g, '');
                    const uriArray = uri.split("/");
                    var action = uriArray[1];
                    if (action === undefined) {
                        action = "";
                    }
                    return action;
                },
                    // at this point have the path, controler, and action names
                _digestRoute : function(model, scope) {
                    
                    // find route accociated with controller and action
                    var route = this._findRoute(model);

                    // not found
                    if(route === null){
                            // TODO: if no routes found then just call regular routes and default to get
                            this._call(model, scope);
                            return 1;
                        }

                    else{
                        // digest new route from routes
                        var routeNameSpace = this._getNameSpaceFromURI(route.toPath);
                        var routeController = this._getControllerFromURI(route.toPath);

                        this._call({
                            name: routeController,
                            namespace: routeNameSpace,
                            type: model.type
                        }, scope);

                        return {
                            controller :model
                        }
                    }
                },
                        // find the route associated with controller, action and type
                _findRoute : function(model){
                    // namepsace and controller come from the page URL;
                    var path = name === "" ? model.namespace : model.namespace + "/" + model.name;
                    
                    // loop through routes
                    for(var item in this._routeList){
                        // remove forward slash "/" from string start and end
                        var routePath = this._routeList[item].path.replace(/^\/|\/$/g, '');

                        if(routePath === path && this._routeList[item].type === model.type){
                            return this._routeList[item];
                        }else{
                            return null;
                        }
                    };
                    return null;
                },
                _call : function (model, scope) {

                    if(model.namespace){

                           var counter = 0;

                            // loop through all the controller that were loaded 
                            if (this._controllerList.length > 0) {
                                // call an anonymous function that has object
                                this._controllerList.forEach(function (callback) {
                                    // only call the ones that we find in the DOM
                                    if (model.name === callback.name && model.namespace === callback.namespace && model.type === callback.type) {
                                        counter++;
                                        if(callback.func !== undefined ){
                                            callback.func(scope);
                                        }
                                    }
                                });
                            }
                    }
                }
        }
    });   

});



( function( global, factory ) {

    "use strict";

    if ( typeof module === "object" && typeof module.exports === "object" ) {
        module.exports = factory( global );
    } else {
        factory( global );
    }

// Pass this if window is not defined yet
} )( typeof window !== "undefined" ? window : this, function( window, noGlobal ) {

     MasterController.extend({
        route : function(path, toPath, type){

                var route = {
                    type: type,
                    path: path,
                    toPath :toPath
                }

                MasterController.utils._routeList.push(route);
                return MasterController.fn;
        }
    });

    // will get the url and hash
    MasterController.extend({

        spa : function(isHash){
            console.log("aaps")
            
            var controllerModal = Object.create(MasterController.utils._controllerModal);
            isHash = isHash === null ? false : isHash;

            if (isHash === true) {

                var onloadHash = window.location.hash;
                var controller = MasterController.utils._getNameSpaceFromURI(onloadHash);
                controller = controller === undefined || controller === "" ? "root" : controller;
                var action = MasterController.utils._getControllerFromURI(onloadHash);
                action = action === undefined || action === "" ? "index" : action;

                if (controller != null) {
                    MasterController.utils._digestRoute(controller, action);
                } else {
                   throw new Error("Cannot find Controller");
                }

                // this starts listening to url hash changes
                window.onhashchange = function() {
                    var currentHash = window.location.hash;
                    var controller = MasterController.utils._getNameSpaceFromURI(currentHash);
                    controller = controller === undefined || controller === "" ? "root" : controller;
                    var action = MasterController.utils._getControllerFromURI(currentHash);
                    action = action === undefined || action === "" ? "index" : action;
                    MasterController.utils._digestRoute(controller, action);
                };

            } else {
                // get url path
                var onloadPath = window.location.pathname;
                controllerModal.namespace = MasterController.utils._getNameSpaceFromURI(onloadPath);
                controllerModal.name = MasterController.utils._getControllerFromURI(onloadPath);
                controllerModal.type= "get";
                MasterController.utils._digestRoute(controllerModal, this);
            }
        }
    });

    MasterController.extend({

        node : function(request, response) {
                // node stuff
                var url = require("url");
                request.requrl = url.parse(request.url, true);

                // test if request is a css file using regular expression
                if (/.(css)$/.test(request.requrl)) {
                    
                    response.writeHead(200, {
                      'Content-Type': 'text/css'
                    });
                    
                    // get css file
                    fileserver.readFile(__dirname + request.requrl, 'utf8', function(err, data) {
                      if (err) throw err;
                      response.write(data, 'utf8');
                      response.end();
                    });

                }
                else{
                        var controller = MasterController.utils._getNameSpaceFromURI(request.requrl.pathname);
                        var action = MasterController.utils._getControllerFromURI(request.requrl.pathname);

                        // call master controller and controller to load page
                        const controllerUrl = "../app/controllers/" + controller + "_controller";
                        // always call the master controller first before any controllers
                        const masterUrl = "../app/controllers/master_controller"; 
                        // call the javascript pages
                        require(masterUrl);
                        require(controllerUrl);

                        MasterController.utils._digestRoute(controllerName, actionName, request.method);
                }
        }
    });

    // build json representation of the view page
     MasterController.extend({
            dom : function(){
                // should be only one controller per page
                var controllerSelector = window.document.querySelector("[fan-controller]");
                // check that we find a controller declaration inside the app declaration
                if (controllerSelector !== undefined && controllerSelector !== null) {
                        // set object literal with data.
                        var controllerModal = Object.create(MasterController.utils._controllerModal);
                        controllerModal.namespace = controllerSelector.getAttribute("fan-namespace");
                        controllerModal.name = controllerSelector.getAttribute("fan-controller");
                        controllerModal.type = controllerSelector.getAttribute("fan-type");
                        MasterController.utils._digestRoute(controllerModal, controllerSelector);

                        return {
                            refresh:function(scope){
                                if(scope !== null && scope !== undefined){
                                    var refreshScope = scope.querySelector("[fan-controller]");
                                    if (refreshScope!== undefined && refreshScope !== null) {
                                        var refreshControllerName = refreshScope.getAttribute("fan-controller");
                                        var refreshNamespace = refreshScope.getAttribute("fan-namespace");
                                        var $refreshType =refreshScope.getAttribute("fan-type");
                                        $refreshType = $refreshType === null ? "get": $refreshType;

                                        MasterController.utils._digestRoute({
                                            name: refreshControllerName,
                                            type:$refreshType,
                                            namespace: refreshNamespace,
                                            scope :scope
                                        });
                                    }
                                            
                                }else{
                                    throw new Error("Must provide a scope to refresh ");
                                }
                            }
                        }
                }
            }
    });
});
