var master = require('mastercontroller');
var _beforeActionList = [];
var _afterActionList = [];
var emit = "";

class MasterActionFilters {
    constructor() {
        this.namespace = this.constructor.name;
    }

    // add function to list
    beforeAction(actionlist, func){
        if (typeof func === 'function') {
            var namespace = (this.namespace.toLowerCase()).replace(/controller/g, "");
            _beforeActionList.push({
                namespace :   namespace,
                actionList : actionlist,
                callBack : func,
                that : this
            });
        }
        else{
            master.error.log("beforeAction callback not a function", "warn");
        }
 
    }

    // add function to list
    afterAction(actionlist, func){
        if (typeof func === 'function') {
            var namespace = (this.namespace.toLowerCase()).replace(/controller/g, "");
            _afterActionList.push({
                namespace :   namespace,
                actionList : actionlist,
                callBack : func,
                that : this
            });
        }
        else{
            master.error.log("afterAction callback not a function", "warn");
        }
 
    }
    
    // check to see if that controller has a before Action method.
    __hasBeforeAction(obj){
        var filterList = _beforeActionList;
        for (var i = 0; i < filterList.length; i++) { 
            if(filterList[i].namespace === obj.namespace){
                for (var a = 0; a < filterList[i].actionList.length; a++) { 
                    if(filterList[i].actionList[a] === obj.action){
                        return true;
                    }
                }
            }
        }
        return false;
    }

    __callBeforeAction(obj, emitter) {
        if(_beforeActionList[0] !== undefined){
            if(_beforeActionList[0].namespace === obj.namespace){
                _beforeActionList[0].actionList.forEach(action => {
                    if(action === obj.action){
                        emit = emitter;
                        var arry = _beforeActionList[0];
                        _beforeActionList.splice(0, 1);
                        arry.callBack.call(arry.that, obj);
                    }
                });
            };
        };
     }

     __callAfterAction(obj) {
        if(_afterActionList[0] !== undefined){
            if(_afterActionList[0].namespace === obj.namespace){
                    _afterActionList[0].actionList.forEach(action => {
                        if(action === obj.action){
                            var arry = _afterActionList[0];
                            arry.that.next = function(){
                                this.callAfterAction(obj);
                            }
                            _afterActionList.splice(0, 1);
                            arry.callBack.call(arry.that, obj);
                        }
                    });
            };
        };
     }

     next(){
        if(_beforeActionList.length === 0){
            emit.emit("controller");
        }
        else{
            this.callBeforeAction(this, emit);
        }
     }
}

master.extendController(MasterActionFilters);
//module.exports = MasterActionFilters;