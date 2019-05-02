// MasterSocket- by Alexander Batista - Tailor 2018 - MIT Licensed 
// version 1.0.13 - beta -- node compatiable

var master = require('./MasterControl');

var jsUcfirst = function(string){
    return string.charAt(0).toUpperCase() + string.slice(1);
};

class MasterSocket{
    
    init(){
        this._baseurl = master.root;
    }

    async load(data, socket, io){
        var controller = jsUcfirst(socket.handshake.query.controller);
        if(controller){
            try{
                var moduleName = this._baseurl + "/app/sockets/" + controller + "Socket";
                //delete require.cache[require.resolve(moduleName)];
                var BoardSocket = require(moduleName);
                var bs = new BoardSocket();
                bs.request = socket.request;
                bs.response = socket.response;
                bs.namespace = (controller).toLowerCase();
                bs.action = data[0];
                bs.type = "socket";

                data.request = socket.request;
                data.response = socket.response;
                data.namespace = (controller).toLowerCase();
                data.action = data[0];
                data.type = "socket";
                
                if(bs.callBeforeAction !== undefined){
                    await bs.callBeforeAction(data);
                }

                bs[data[0]](data[1], socket, io);
            }
            catch(ex){
                master.error.log(ex, "warn");
            }

        }
    }
}

master.extend({socket: new MasterSocket()});