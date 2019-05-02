var master = require('./MasterControl');

var temp = {};
class MasterTemp{
    add(name, data){

        if(name !== "add" && name !== "clear"){
            this[name] = data;
        }
        else{
            master.error.log("cannot use tempdata name add or clear", "warn");
        }
    }

    clearAll(){
        for (var key in this) {
            if (temp.hasOwnProperty(key)) {
                if(temp[key] !== "add" && temp[key] !== "clear"){
                    delete temp[key];
                }
            }
        };
    }

}

master.extend({tempdata: new MasterTemp()});