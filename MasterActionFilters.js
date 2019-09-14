// version 1.3
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
            var namespace = (this.__namespace.toLowerCase()).replace(/controller/g, "");
            _beforeActionFunc ={
                namespace :   namespace,
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
            var namespace = (this.__namespace.toLowerCase()).replace(/controller/g, "");
            _afterActionFunc = {
                namespace :   namespace,
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
    __hasBeforeAction(obj){
        var flag = false;
        if(_beforeActionFunc.namespace === obj.namespace){
            for (var a = 0; a < _beforeActionFunc.actionList.length; a++) { 
                if(_beforeActionFunc.actionList[a] === obj.action){
                    flag = true;
                }
            }
        }
        return flag;
    }

    __callBeforeAction(obj, emitter) {
            if(_beforeActionFunc.namespace === obj.namespace){
                _beforeActionFunc.actionList.forEach(action => {
                    if(action === obj.action){
                        emit = emitter;
                        // call function inside controller 
                        _beforeActionFunc.callBack.call(_beforeActionFunc.that, obj);
                    }
                });
            };
     }

     __callAfterAction(obj) {
            if(_afterActionFunc.namespace === obj.namespace){
                _afterActionFunc.actionList.forEach(action => {
                        if(action === obj.action){
                            _afterActionFunc.callBack.call(_afterActionFunc.that, obj);
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