const electron = require('electron');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const url = require('url');
const iconv = require('iconv-lite');

const app = electron.app;
const Menu = electron.Menu;
const BrowserWindow = electron.BrowserWindow;
const Rpc = require('electron-ipc-rpc');

let ipcRpc;
let stopping;

const windowStateKeeper = require('electron-window-state');
const isDev = require('electron-is-dev');

const unhandled = require('electron-unhandled');

unhandled();

const request = require('request');

const pjson = require('persist-json')('hm-manager');
const nextPort = require('nextport');
const hmDiscover = require('hm-discover');

const async = require('async');

const xmlrpc = require('homematic-xmlrpc');
const binrpc = require('binrpc');

const Rega = require('homematic-rega');

let rega;
let regaPresent = false;

const invalidateDeviceCache = {};

const log = require('yalm');

const pkg = require('./package.json');

log.setLevel(isDev ? 'debug' : 'error');

let config = pjson.load('config') || {};

config.version = pkg.version;

config.rpcInitIpSelect = [];
const interfaces = os.networkInterfaces();
Object.keys(interfaces).forEach(i => {
    Object.keys(interfaces[i]).forEach(a => {
        const address = interfaces[i][a];
        if (address.family === 'IPv4' && !address.internal) {
            config.rpcInitIpSelect.push(address.address);
        }
    });
});

config.rpcListenIp = config.rpcListenIp || '0.0.0.0';

if (config.rpcInitIpSelect.indexOf(config.rpcInitIp) === -1) {
    config.rpcInitIp = config.rpcInitIpSelect[0];
}

config.language = config.language || 'de';

config.ccuAddressSelect = [];
hmDiscover(f => {
    config.ccuAddressSelect = f;
});

let mainWindow;

function createWindow() {
    const mainWindowState = windowStateKeeper({
        defaultWidth: 1280,
        defaultHeight: 960,
        minHeight: 620,
        minWidth: 1200
    });

    const devWindowState = {
        width: 1860,
        height: 1024
    };

    const windowState = isDev ? devWindowState : mainWindowState;

    mainWindow = new BrowserWindow(windowState);

    if (!isDev) {
        mainWindowState.manage(mainWindow);
    }

    mainWindow.loadURL(url.format({
        pathname: path.join(__dirname, 'www', 'index.html'),
        protocol: 'file:',
        slashes: true
    }));

    if (isDev) {
        mainWindow.webContents.openDevTools();
    }

    const template = [{
        label: 'Application',
        submenu: [
            {label: 'About Homematic Manager', selector: 'orderFrontStandardAboutPanel:'},
            {type: 'separator'},
            {label: 'Quit', accelerator: 'Command+Q', click: app.quit}
        ]}, {
        label: 'Edit',
        submenu: [
            {label: 'Cut', accelerator: 'CmdOrCtrl+X', selector: 'cut:'},
            {label: 'Copy', accelerator: 'CmdOrCtrl+C', selector: 'copy:'},
            {label: 'Paste', accelerator: 'CmdOrCtrl+V', selector: 'paste:'}
        ]}];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));

    ipcRpc = new Rpc(electron.ipcMain, mainWindow.webContents);
    initIpc();

    nextPort(2000, port => {
        config.rpcListenPort = port;
        nextPort(port + 1, portBin => {
            config.rpcListenPortBin = portBin;
            findInterfaces();
        });
    });
}

function checkservice(host, port, callback) {
    const c = net.connect({
        port,
        host,
        timeout: this.timeout
    }, () => {
        callback(null, true);
        c.end();
    });
    c.on('error', () => {
        callback(null, false);
    });
}

function findInterfaces() {
    const ports = {
        'BidCos-Wired': 2000,
        'BidCos-RF': 2001,
        HmIP: 2010,
        CUxD: 8701,
        rega: 8181
    };
    const queue = {};
    Object.keys(ports).forEach(iface => {
        queue[iface] = callback => {
            checkservice(config.ccuAddress, ports[iface], callback);
        };
    });

    async.parallel(queue, (err, res) => {
        regaPresent = res.rega;
        config.daemons = {};
        Object.keys(res).forEach(iface => {
            if (res[iface] && iface !== 'rega') {
                config.daemons[iface] = {
                    type: iface,
                    ip: config.ccuAddress,
                    port: ports[iface],
                    protocol: iface === 'HmIP' ? 'xmlrpc' : 'binrpc',
                    reinitTimeout: iface === 'HmIP' ? 240000 : 45000
                };
            }
        });
        initRpcClients();
        if (regaPresent) {
            rega = new Rega({
                host: config.ccuAddress
            });
            getRegaNames();
        }
    });
}

app.on('ready', () => {
    createWindow();
});

app.on('window-all-closed', () => {
    app.quit();
});

app.on('activate', () => {
    log.debug('...activate!');
    if (mainWindow === null) {
    //    CreateWindow();
    }
});

app.on('quit', stop);

const localNames = pjson.load('names_' + config.ccuAddress) || {};
const localRegaId = {};
// Const localNamesIds = {};
const localDevices = pjson.load('devices_' + config.ccuAddress) || {};
const localParamsetDescriptions = pjson.load('paramset-descriptions-v2_' + config.ccuAddress) || {};
const rpcClients = {};

let rpcServer;
let rpcServerBin;
let rpcServerStarted;
let rpcServerBinStarted;
const daemonIndex = {};
const lastEvent = {};
const connected = {};

function initRpcClients() {
    log.info('initRpcClients');

    function init(_daemon) {
        const protocol = (config.daemons[_daemon].protocol === 'binrpc' ? 'xmlrpc_bin://' : 'http://');
        const port = (config.daemons[_daemon].protocol === 'binrpc' ? config.rpcListenPortBin : config.rpcListenPort);
        const initUrl = protocol + config.rpcInitIp + ':' + port;
        const ident = config.daemons[_daemon].ident;

        log.debug('RPC -> ' + config.daemons[_daemon].ip + ':' + config.daemons[_daemon].port + ' init ' + initUrl + ' ' + ident);
        rpcClients[_daemon].methodCall('init', [initUrl, ident], (err, data) => {
            log.debug('    <- init response ' + JSON.stringify(err) + ' ' + JSON.stringify(data));
            if (!err) {
                lastEvent[_daemon] = (new Date()).getTime();
                connected[_daemon] = true;
                ipcRpc.send('connection', [connected]);
            }
        });
    }

    function pingPong() {
        const now = (new Date()).getTime();
        Object.keys(config.daemons).forEach(daemon => {
            const elapsed = now - lastEvent[daemon];
            if (elapsed > (config.daemons[daemon].reinitTimeout || 45000)) {
                connected[daemon] = false;
                log.debug('RPC -> re-init ' + daemon + ' ' + elapsed);
                init(daemon);
            } else if (elapsed > (((config.daemons[daemon].reinitTimeout || 45000) / 1.5) - 1000)) {
                log.debug('RPC -> ping ' + daemon + ' ' + elapsed);
                rpcClients[daemon].methodCall('ping', ['hmm'], err => {
                    if (err) {
                        log.error('RPC -> ping', err);
                    }
                });
            }
        });
        ipcRpc.send('connection', [connected]);
    }

    let count = 0; // Math.floor(Math.random() * 65536);
    Object.keys(config.daemons).forEach(daemon => {
        config.daemons[daemon].ident = 'hmm_' + count;

        daemonIndex[config.daemons[daemon].ident] = daemon;

        rpcClients[daemon] = (config.daemons[daemon].protocol === 'binrpc' ? binrpc : xmlrpc).createClient({
            host: config.daemons[daemon].ip,
            port: config.daemons[daemon].port,
            path: '/'
        });

        initRpcServer(config.daemons[daemon].protocol);
        init(daemon);

        count += 1;
    });
    setInterval(pingPong, 15000);
}

const rpcMethods = {
    'system.multicall'(err, params, callback) {
        const queue = [];
        params[0].forEach(c => {
            const m = c.methodName;
            const p = c.params;
            if (rpcMethods[m]) {
                queue.push(cb => {
                    rpcMethods[m](null, p, cb);
                });
            } else {
                log.debug('RPC <- undefined method ' + m + ' ' + JSON.stringify(p).slice(0, 80));
                queue.push(cb => {
                    cb(null, '');
                });
            }
        });
        async.series(queue, callback);
    },
    event(err, params, callback) {
        log.debug('RPC <- event ' + JSON.stringify(params));
        lastEvent[daemonIndex[params[0]]] = (new Date()).getTime();
        if (!stopping) {
            ipcRpc.send('rpc', ['event', params]);
        }
        callback(null, '');
    },
    newDevices(err, params, callback) {
        log.debug('RPC <- newDevices ' + JSON.stringify(params).slice(0, 80));
        ipcRpc.send('rpc', ['newDevices', params]);
        mainWindow.webContents.send('rpc', ['newDevices', params]);
        const daemon = daemonIndex[params[0]];
        if (!localDevices[daemon]) {
            localDevices[daemon] = {};
        }
        for (let i = 0; i < params[1].length; i++) {
            const dev = params[1][i];
            localDevices[daemon][dev.ADDRESS] = dev;
        }
        pjson.save('devices_' + config.ccuAddress, localDevices);
        callback(null, '');
    },
    deleteDevices(err, params, callback) {
        log.debug('RPC <- deleteDevices ' + JSON.stringify(params));
        ipcRpc.send('rpc', ['deleteDevices', params]);
        const daemon = daemonIndex[params[0]];
        if (!localDevices[daemon] || !params[1]) {
            return;
        }

        for (let i = 0; i < params[1].length; i++) {
            const address = params[1][i];
            delete localDevices[daemon][address];
        }
        pjson.save('devices_' + config.ccuAddress, localDevices);
        callback(null, '');
    },
    replaceDevice(err, params, callback) {
        log.debug('RPC <- replaceDevice ' + JSON.stringify(params));
        ipcRpc.send('rpc', ['replaceDevice', params]);
        const daemon = daemonIndex[params[0]];
        if (!localDevices[daemon] || !params[1]) {
            return;
        }
        localNames[params[2]] = localNames[params[1]];
        delete localNames[params[1]];
        pjson.save('names_' + config.ccuAddress, localNames);
        delete localDevices[daemon][params[1]];
        pjson.save('devices_' + config.ccuAddress, localDevices);
        callback(null, '');
    },
    listDevices(err, params, callback) {
        log.debug('RPC <- listDevices ' + JSON.stringify(params));
        ipcRpc.send('rpc', ['listDevices', params]);
        const daemon = daemonIndex[params[0]];
        const res = [];
        if (localDevices[daemon]) {
            Object.keys(localDevices[daemon]).forEach(address => {
                if (daemon === 'HmIP') {
                    const d = localDevices[daemon][address];
                    const dev = {
                        ADDRESS: d.ADDRESS,
                        VERSION: d.VERSION,
                        AES_ACTIVE: d.AES_ACTIVE,
                        CHILDREN: d.CHILDREN,
                        DIRECTION: d.DIRECTION,
                        FIRMWARE: d.FIRMWARE,
                        FLAGS: d.FLAGS,
                        GROUP: d.GROUP,
                        INDEX: d.INDEX,
                        INTERFACE: d.INTERFACE,
                        LINK_SOURCE_ROLES: d.LINK_SOURCE_ROLES,
                        LINK_TARGET_ROLES: d.LINK_TARGET_ROLES,
                        PARAMSETS: d.PARAMSETS,
                        PARENT: d.PARENT,
                        PARENT_TYPE: d.PARENT_TYPE,
                        RF_ADDRESS: d.RF_ADDRESS,
                        ROAMING: d.ROAMING,
                        RX_MODE: d.RX_MODE,
                        TEAM: d.TEAM,
                        TEAM_CHANNELS: d.TEAM_CHANNELS,
                        TEAM_TAG: d.TEAM_TAG,
                        TYPE: d.TYPE
                    };
                    Object.keys(dev).forEach(k => {
                        if (!dev[k]) {
                            delete dev[k];
                        }
                    });
                    res.push(dev);
                } else {
                    res.push({ADDRESS: address, VERSION: localDevices[daemon][address].VERSION});
                }
            });
        }
        log.debug('RPC -> listDevices response length ' + res.length);
        callback(null, res);
    },
    'system.listMethods'(err, params, callback) {
        callback(null, Object.keys(rpcMethods));
    }
};

function initRpcServer(protocol) {
    let server;
    if (protocol === 'binrpc' && !rpcServerBinStarted) {
        rpcServerBinStarted = true;
        rpcServerBin = binrpc.createServer({host: config.rpcListenIp, port: config.rpcListenPortBin});
        server = rpcServerBin;
        log.debug('binrpc server listening on ' + config.rpcListenIp + ':' + (config.rpcListenPortBin));
    } else if (rpcServerStarted) {
        log.debug(protocol + ' server already started');
        return;
    } else {
        rpcServerStarted = true;
        rpcServer = xmlrpc.createServer({host: config.rpcListenIp, port: config.rpcListenPort});
        server = rpcServer;
        log.debug('xmlrpc server listening on ' + config.rpcListenIp + ':' + (config.rpcListenPort));
    }

    server.on('NotFound', (method, params) => {
        log.debug('RPC <- undefined method ' + method + ' ' + JSON.stringify(params).slice(0, 80));
    });

    Object.keys(rpcMethods).forEach(m => {
        server.on(m, rpcMethods[m]);
    });
}

function initIpc() {
    ipcRpc.on('config', params => {
        config = params[0];
        console.log(config);
        pjson.save('config', config);
        app.relaunch();
        mainWindow.destroy();
        stop();
    });

    ipcRpc.on('getConfig', (params, callback) => {
        log.debug('getConfig!');
        callback(null, config);
        ipcRpc.send('connection', [connected]);
    });

    ipcRpc.on('getNames', (params, callback) => {
        callback(null, localNames);
    });

    ipcRpc.on('invalidateDeviceCache', (params, callback) => {
        invalidateDeviceCache[params[0]] = true;
        callback(null);
    });

    ipcRpc.on('setName', (params, callback) => {
        const [address, name] = params;
        localNames[address] = name;
        const queue = [];
        log.debug('local rename ' + address + ' "' + name + '"');
        queue.push({address, name});
        if (!address.match(/:/)) {
            localNames[address + ':0'] = name + ':0';
            queue.push({address: address + ':0', name: name + ':0'});
        }
        pjson.save('names_' + config.ccuAddress, localNames, () => {
            if (!regaPresent && callback) {
                callback();
            }
        });
        if (regaPresent) {
            regaRename(queue, callback);
        }
    });

    ipcRpc.on('setNames', (params, callback) => {
        const [tuples] = params;
        const queue = [];
        tuples.forEach(tuple => {
            const {address, name} = tuple;
            localNames[address] = name;
            queue.push({address, name});
            log.debug('local rename ' + address + ' "' + name + '"');
            if (!address.match(/:/)) {
                localNames[address + ':0'] = name + ':0';
                queue.push({address: address + ':0', name: name + ':0'});
            }
        });
        pjson.save('names_' + config.ccuAddress, localNames, () => {
            if (!regaPresent && callback) {
                callback();
            }
        });
        if (regaPresent) {
            regaRename(queue, callback);
        }
    });

    function regaRename(names, callback) {
        let script = 'var hmm_o;\n';
        names.forEach(tuple => {
            const {address, name} = tuple;
            if (localRegaId[address]) {
                script += `hmm_o = dom.GetObject(${localRegaId[address]});\n`;
                script += `hmm_o.Name("${name}");\n`;
            }
        });
        rega.script(script, err => {
            if (err) {
                log.error(err);
            }
            callback(err);
        });
    }

    ipcRpc.on('rpc', (params, callback) => {
        log.debug('ipcRpc <', params);
        const daemon = params[0];
        const method = params[1];
        const paramArray = params[2];
        if (!rpcClients[daemon]) {
            log.debug('RPC unknown daemon ' + daemon);
            if (callback) {
                callback(new Error('unknown daemon'), null);
            }
            return;
        }
        if (method) {
            rpcProxy(daemon, method, paramArray, callback);
        }
    });
}

function paramsetName(daemon, device, paramset) {
    let cType = '';
    let d;
    if (device) {
        if (device.PARENT) {
            // Channel
            cType = device.TYPE;
            d = localDevices[daemon][device.PARENT];
        } else {
            // Device
            d = device;
        }
        return [daemon, d.TYPE, d.FIRMWARE, d.VERSION, cType, paramset].join('/');
    }
}

function rpcProxy(daemon, method, params, callback) {
    switch (method) {
        case 'listDevices': {
            if (invalidateDeviceCache[daemon]) {
                rpcClients[daemon].methodCall('listDevices', params, (err, res) => {
                    if (!err && res) {
                        delete invalidateDeviceCache[daemon];
                        localDevices[daemon] = {};
                        res.forEach(dev => {
                            localDevices[daemon][dev.ADDRESS] = dev;
                        });
                    }
                    res = res || [];
                    log.debug('RPC -> respond to listDevices from interface (' + res + ')');
                    callback(err, res);
                });
            } else {
                const res = [];
                if (localDevices[daemon]) {
                    Object.keys(localDevices[daemon]).forEach(address => {
                        res.push(localDevices[daemon][address]);
                    });
                }
                log.debug('RPC -> respond to listDevices from cache (' + res.length + ')');
                callback(null, res);
            }
            break;
        }
        case 'getParamsetDescription': {
            const dev = localDevices[daemon][params[0]];

            const ident = paramsetName(daemon, dev, params[1]);

            if (localParamsetDescriptions[ident]) {
                log.debug('paramset cache hit ' + ident);
                callback(null, localParamsetDescriptions[ident]);
            } else {
                log.debug('paramset not in cache ' + ident);
                log.debug('RPC -> ' + config.daemons[daemon].ip + ':' + config.daemons[daemon].port + ' ' + method + '(' + JSON.stringify(params).slice(1).slice(0, -1).replace(/,/, ', ') + ')');
                rpcClients[daemon].methodCall(method, params, (error, result) => {
                    console.log('rpc response ' + config.daemons[daemon].ip + ':' + config.daemons[daemon].port + ' ' + method, error, result);
                    if (!error && result) {
                        localParamsetDescriptions[ident] = result;
                    }
                    pjson.save('paramset-descriptions-v2_' + config.ccuAddress, localParamsetDescriptions);
                    if (callback) {
                        callback(error, result);
                    }
                });
            }
            break;
        }
        default:
            log.debug('RPC -> ' + config.daemons[daemon].ip + ':' + config.daemons[daemon].port + ' ' + method + '(' + JSON.stringify(params).slice(1).slice(0, -1).replace(/,/, ', ') + ')');
            rpcClients[daemon].methodCall(method, params, (error, result) => {
                if (callback) {
                    console.log('rpc response ' + config.daemons[daemon].ip + ':' + config.daemons[daemon].port + ' ' + method, error, result);
                    callback(error, result);
                }
            });
    }
}

function getRegaNames() {
    rega.getChannels((err, res) => {
        if (err) {
            throw err;
        } else if (res && res.length) {
            log.debug('got', Object.keys(res).length, 'rega names');
            res.forEach(ch => {
                localNames[ch.address] = ch.name;
                localRegaId[ch.address] = ch.id;
            });
            pjson.save('names_' + config.ccuAddress, localNames);
        } else {
            throw new Error('rega.getChannels empty result');
        }
        console.log(err, res);
    });
}

function stop() {
    if (stopping) {
        log.debug('force terminate');
        app.quit();
        process.exit(1); // eslint-disable-line unicorn/no-process-exit
    }
    stopping = true;

    const tasks = [];
    Object.keys(config.daemons).forEach(daemon => {
        const protocol = (config.daemons[daemon].protocol === 'binrpc' ? 'xmlrpc_bin://' : 'http://');
        const initUrl = protocol + config.rpcInitIp + ':' + (config.daemons[daemon].protocol === 'binrpc' ? config.rpcListenPortBin : config.rpcListenPort);
        tasks.push(cb => {
            log.debug('RPC -> ' + config.daemons[daemon].ip + ':' + config.daemons[daemon].port + ' init ' + initUrl + ' ""');
            rpcClients[daemon].methodCall('init', [initUrl, ''], (err, data) => {
                log.debug('    <- ' + JSON.stringify(err) + ' ' + JSON.stringify(data));
                cb(null, data);
            });
        });
    });
    async.parallel(tasks, () => {
        log.debug('terminate');
        app.quit();
        process.exit(0); // eslint-disable-line unicorn/no-process-exit
    });
    setTimeout(stop, 2000);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
