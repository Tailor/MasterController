// version 1.4
var master = require('mastercontroller');
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
                if(_beforeActionFunc.actionList[a] === request.toAction){
                    flag = true;
                }
            }
        }
        return flag;
    }

    __callBeforeAction(obj, request, emitter) {
            if(_beforeActionFunc.namespace === obj.__namespace){
                _beforeActionFunc.actionList.forEach(action => {
                    if(action === request.toAction){
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
                        if(action === request.toAction){
                            _afterActionFunc.callBack.call(_afterActionFunc.that, request);
                        }
                    });
            };
     }

     next(){
        emit.emit("controller");
     }
}

master.extendController(MasterActionFilters);
//module.exports = MasterActionFilters;