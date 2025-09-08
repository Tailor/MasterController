// version 1.7
var master = require('./MasterControl');

var _beforeActionFunc = {
    namespace :   "",
    actionList : "",
    callBack : "",
    that : ""
};
var _afterActionFunc = {
    namespace :   "",
    actionList : "",
    callBack : "",
    that : ""
};
var emit = "";

class MasterActionFilters {

    // add function to list
    beforeAction(actionlist, func){
        if (typeof func === 'function') {
            _beforeActionFunc = {
                namespace : this.__namespace,
                actionList : actionlist,
                callBack : func,
                that : this
            };
        }
        else{
            master.error.log("beforeAction callback not a function", "warn");
        }
 
    }

    // add function to list
    afterAction(actionlist, func){
        if (typeof func === 'function') {
            _afterActionFunc = {
                namespace : this.__namespace,
                actionList : actionlist,
                callBack : func,
                that : this
            };
        }
        else{
            master.error.log("afterAction callback not a function", "warn");
        }
 
    }
    
    // check to see if that controller has a before Action method.
    __hasBeforeAction(obj, request){
        var flag = false;
        if(_beforeActionFunc.namespace === obj.__namespace){
            for (var a = 0; a < _beforeActionFunc.actionList.length; a++) { 
                var action = request.toAction.replace(/\s/g, '');
                var incomingAction = _beforeActionFunc.actionList[a].replace(/\s/g, '');
                if(incomingAction === action){
                    flag = true;
                }
            }
        }
        return flag;
    }

    __callBeforeAction(obj, request, emitter) {
            if(_beforeActionFunc.namespace === obj.__namespace){
                _beforeActionFunc.actionList.forEach(action => {
                    var action = action.replace(/\s/g, '');
                    var reqAction = request.toAction.replace(/\s/g, '');
                    if(action === reqAction){
                        emit = emitter;
                        // call function inside controller 
                        _beforeActionFunc.callBack.call(_beforeActionFunc.that, request);
                    }
                });
            };
     }

     __callAfterAction(obj, request) {
            if(_afterActionFunc.namespace === obj.__namespace){
                _afterActionFunc.actionList.forEach(action => {
                        var action = action.replace(/\s/g, '');
                        var reqAction = request.toAction.replace(/\s/g, '');
                        if(action === reqAction){
                            _afterActionFunc.callBack.call(_afterActionFunc.that, request);
                        }
                    });
            };
     }

     next(){
        emit.emit("controller");
     }
}

master.extendController( MasterActionFilters);