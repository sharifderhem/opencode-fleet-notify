const { EventEmitter } = require('node:events');
const net = require('node:net');
const port = new EventEmitter(); process.parentPort = port;
let selected;
port.postMessage = msg => {
 if (msg.type === 'ready') console.log(`server listening on http://127.0.0.1:${selected}`);
 if (msg.type === 'error') { console.error(msg.error); process.exit(1); }
};
(async () => {
 await import((process.env.OPENCODE_DESKTOP_ASAR ?? '/opt/OpenCode/resources/app.asar') + '/out/main/sidecar.js');
 const server = net.createServer();
 await new Promise(r => server.listen(0,'127.0.0.1',r));selected=server.address().port;
 await new Promise(r => server.close(r));
 port.emit('message',{data:{type:'start',hostname:'127.0.0.1',port:selected,password:'fixture-password',userDataPath:process.env.XDG_STATE_HOME}});
})();
process.on('SIGTERM',()=>port.emit('message',{data:{type:'stop'}}));
