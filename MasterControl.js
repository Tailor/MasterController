
// MasterControl - by Alexander Batista - Tailor 2017 - MIT Licensed 
// version 1.0.11 - beta -- node compatiable

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

/* ========================================================================================================= */
/* ====================================== Extention Functions ============================================== */
/* ========================================================================================================= */


    MasterController.extend({
        _controllerList :[],
        _call : function (model, scope) {

            if(model.namespace){

                   var counter = 0;

                    // loop through all the controller that were loaded 
                    if (this._controllerList.length > 0) {
                        // call an anonymous function that has object
                        this._controllerList.forEach(function (callback) {
                            // only call the ones that we find in the DOM
                            if (model.action === callback.action && model.namespace === callback.namespace && model.type === callback.type) {
                                counter++;
                                if(callback.func !== undefined ){
                                    callback.func(scope);
                                }
                            }
                        });
                    }
            }
        },
        masterController : function(aFunc){
            if(aFunc !== undefined && aFunc !== null && typeof aFunc === "function"){
                aFunc();
            };
        },
        // call controller using name
        call : function(options, scope){

            var controllerOptions = {
                namespace : options.namespace,
                action: options.action,
                type: options.type
            };

            var returnController = this._call(controllerOptions, scope);
            return returnController;
        },

        // this gets called by the declairation of the function on the page
        controller : function (options, aFunction) {

            var controllerOptions = {
                namespace : options.namespace,
                action: options.action,
                type: options.type,
                func : aFunction
            };

            this._controllerList.push(controllerOptions);
            return this;
        }

    });

    return MasterController;
});

