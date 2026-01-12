// version 0.0.3

class MasterTemp{

    temp = {};

    // Lazy-load master to avoid circular dependency (Google-style lazy initialization)
    get _master() {
        if (!this.__masterCache) {
            this.__masterCache = require('./MasterControl');
        }
        return this.__masterCache;
    }

    add(name, data){

        if(name !== "add" && name !== "clear"){
            this[name] = data;
        }
        else{
            this._master.error.log("cannot use tempdata name add or clear", "warn");
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

module.exports = { MasterTemp };