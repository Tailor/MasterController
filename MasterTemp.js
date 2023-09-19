// version 0.0.3
var master = require('./MasterControl');

class MasterTemp{

    temp = {};

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
            if (this.temp.hasOwnProperty(key)) {
                if(this.temp[key] !== "add" && this.temp[key] !== "clear"){
                    delete this.temp[key];
                }
            }
        };
    }

}

master.extend("tempdata", MasterTemp);