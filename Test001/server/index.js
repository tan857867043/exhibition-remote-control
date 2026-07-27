const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ========== 会话存储 ==========
let sessions = {};
const users = { admin: { password: 'admin123', role: 'admin' } };
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
try { if (fs.existsSync(SESSIONS_FILE)) sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch(e) {}

function saveSessions() {
    try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions), 'utf8'); } catch(e) {}
}

// ========== 服务器配置 ==========
const CONFIG_PATH = path.join(__dirname, 'config.json');
let serverConfig = {};
if (fs.existsSync(CONFIG_PATH)) {
    try {
        serverConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        console.log('Config loaded, agentDnsAlias:', serverConfig.agentDnsAlias || '(not set)');
    } catch (e) {
        console.log('Config file invalid, using defaults.');
    }
} else {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ agentDnsAlias: '' }, null, 2), 'utf8');
    console.log('Default config file created.');
}

// 获取服务器本地 IP
function getServerIP() {
    try {
        const os = require('os');
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) return iface.address;
            }
        }
    } catch (e) {}
    return '127.0.0.1';
}

// ========== DeviceHub 类 ==========
class DeviceHub {
    constructor() {
        this.agents = new Map();
        this.subscribers = new Map();
        this.deviceInfos = new Map();
        this.heartbeatMap = new Map();
        this.heartbeatTimer = null;
        this.startHeartbeatCheck();
    }

    startHeartbeatCheck() {
        this.heartbeatTimer = setInterval(() => {
            const now = Date.now();
            for (const [deviceId, timestamp] of this.heartbeatMap) {
                if (now - timestamp > 30000) {
                    this.markOffline(deviceId);
                }
            }
        }, 5000);
    }

    registerAgent(deviceId, ws, info) {
        this.agents.set(deviceId, ws);
        this.deviceInfos.set(deviceId, {
            id: deviceId,
            name: info.name || 'Unknown',
            os: info.os || 'Unknown',
            ip: info.ip || 'Unknown',
            resolution: info.resolution || 'Unknown',
            online: true,
            connectedAt: Date.now()
        });
        this.heartbeatMap.set(deviceId, Date.now());
        if (!this.subscribers.has(deviceId)) {
            this.subscribers.set(deviceId, new Set());
        }
        console.log('Agent registered:', deviceId, info.name);
    }

    unregisterAgent(deviceId) {
        this.agents.delete(deviceId);
        this.heartbeatMap.delete(deviceId);
        
        const info = this.deviceInfos.get(deviceId);
        if (info) {
            info.online = false;
        }
        
        const subscribers = this.subscribers.get(deviceId);
        if (subscribers) {
            for (const ws of subscribers) {
                try { ws.close(4001, 'Device offline'); } catch(e) {}
            }
            this.subscribers.delete(deviceId);
        }
        console.log('Agent unregistered:', deviceId);
    }

    markOffline(deviceId) {
        const info = this.deviceInfos.get(deviceId);
        if (info && info.online) {
            info.online = false;
            console.log('Device marked offline:', deviceId);
        }
        this.unregisterAgent(deviceId);
    }

    updateHeartbeat(deviceId) {
        this.heartbeatMap.set(deviceId, Date.now());
    }

    addSubscriber(deviceId, ws) {
        if (!this.subscribers.has(deviceId)) {
            this.subscribers.set(deviceId, new Set());
        }
        this.subscribers.get(deviceId).add(ws);
    }

    removeSubscriber(deviceId, ws) {
        const subscribers = this.subscribers.get(deviceId);
        if (subscribers) {
            subscribers.delete(ws);
            if (subscribers.size === 0) {
                this.subscribers.delete(deviceId);
            }
        }
    }

    broadcastBinary(deviceId, data) {
        const subscribers = this.subscribers.get(deviceId);
        if (subscribers) {
            for (const ws of subscribers) {
                if (ws.readyState === ws.OPEN) {
                    try { ws.send(data); } catch(e) {}
                }
            }
        }
    }

    getOnlineDevices() {
        return Array.from(this.deviceInfos.values()).filter(d => d.online);
    }

    getDeviceInfo(deviceId) {
        return this.deviceInfos.get(deviceId);
    }

    getAgentWs(deviceId) {
        return this.agents.get(deviceId);
    }
}

const deviceHub = new DeviceHub();

// ========== 认证中间件 ==========
function authMiddleware(req, res, next) {
    const token = req.cookies.token || req.headers['x-api-token'];
    if (token && sessions[token]) {
        req.user = sessions[token];
        next();
    } else {
        if (req.path.startsWith('/api/') && req.path !== '/api/login') {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    }
}
app.use(authMiddleware);

// ========== REST API 路由 ==========
// 登录
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (users[username] && users[username].password === password) {
        const token = uuidv4();
        sessions[token] = { username, role: users[username].role };
        saveSessions();
        res.json({ token, username });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

// 登出
app.post('/api/logout', (req, res) => {
    if (req.cookies.token) delete sessions[req.cookies.token];
    res.json({ ok: true });
});

// 获取在线设备列表（新路由）
app.get('/api/v1/devices', (req, res) => {
    const devices = deviceHub.getOnlineDevices().map(d => ({
        id: d.id,
        name: d.name,
        os: d.os,
        ip: d.ip,
        online: d.online,
        resolution: d.resolution,
        connectedAt: d.connectedAt
    }));
    res.json(devices);
});

// 转发控制命令到 Agent（新路由）
app.post('/api/v1/control', (req, res) => {
    const { device_id, action, payload } = req.body;
    if (!device_id || !action) {
        return res.status(400).json({ error: 'device_id and action required' });
    }
    
    const agentWs = deviceHub.getAgentWs(device_id);
    if (!agentWs || agentWs.readyState !== agentWs.OPEN) {
        return res.status(503).json({ error: 'Device offline' });
    }
    
    const cmdId = uuidv4();
    agentWs.send(JSON.stringify({ action, cmdId, payload }));
    
    let timeout;
    const handler = (msg) => {
        try {
            const data = JSON.parse(msg.toString());
            if (data.action === 'exec_result' && data.cmdId === cmdId) {
                clearTimeout(timeout);
                agentWs.removeListener('message', handler);
                res.json({ cmdId, result: data });
            }
        } catch (e) {}
    };
    
    agentWs.on('message', handler);
    
    timeout = setTimeout(() => {
        agentWs.removeListener('message', handler);
        res.status(504).json({ error: 'Control command timeout' });
    }, 30000);
});

// 原有 API 路由（兼容）
app.get('/api/devices', (req, res) => {
    const devices = deviceHub.getOnlineDevices().map(d => ({
        id: d.id,
        name: d.name,
        os: d.os,
        ip: d.ip,
        online: d.online,
        resolution: d.resolution,
        connectedAt: d.connectedAt
    }));
    res.json(devices);
});

app.get('/api/devices/:id', (req, res) => {
    const d = deviceHub.getDeviceInfo(req.params.id);
    if (!d) return res.status(404).json({ error: 'Device not found' });
    res.json({ id: d.id, name: d.name, os: d.os, ip: d.ip, online: d.online, resolution: d.resolution });
});

app.post('/api/agent/register', (req, res) => {
    res.status(400).json({ error: 'Use WebSocket to register' });
});

// 下载预配置 Agent .exe
const EXE_CONFIG_GUID = 'B996015880544A19B7F7E9BE44914C18';

app.get('/api/agent/download', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    
    let serverHost = serverConfig.agentDnsAlias;
    if (!serverHost) {
        serverHost = req.hostname;
        if (serverHost === 'localhost' || serverHost === '127.0.0.1' || serverHost === '::1') {
            serverHost = getServerIP();
        }
    }
    const serverUrl = 'ws://' + serverHost + ':8443/agent/register';
    const deviceName = req.query.name || '';
    const tag = req.query.tag || '';
    const outputName = 'ExhibitionAgent' + (tag ? '_' + tag : '') + '.exe';
    
    const templatePath = path.join(__dirname, '..', 'dist', 'template', 'ExhibitionAgent.exe');
    if (!fs.existsSync(templatePath)) {
        return res.status(500).json({ error: 'Template not found. Run build-template.js first.' });
    }
    
    console.log('Streaming Agent .exe for:', serverUrl);
    
    const configObj = { serverUrl, deviceName: deviceName || '' };
    const configJson = JSON.stringify(configObj);
    const configBuf = Buffer.from(configJson, 'utf8');
    
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(configBuf.length, 0);
    const guidBuf = Buffer.from(EXE_CONFIG_GUID, 'hex');
    const injectData = Buffer.concat([configBuf, lenBuf, guidBuf]);
    
    res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="' + outputName + '"',
        'Content-Length': fs.statSync(templatePath).size + injectData.length
    });
    
    const templateStream = fs.createReadStream(templatePath);
    templateStream.pipe(res, { end: false });
    
    templateStream.on('end', () => {
        res.write(injectData);
        res.end();
    });
    
    templateStream.on('error', (err) => {
        console.error('Stream error:', err);
        try { res.end(); } catch(e) {}
    });
});

app.post('/api/devices/:id/command', (req, res) => {
    const d = deviceHub.getDeviceInfo(req.params.id);
    if (!d) return res.status(404).json({ error: 'Device not found' });
    if (!d.online) return res.status(503).json({ error: 'Device offline' });
    
    const agentWs = deviceHub.getAgentWs(req.params.id);
    if (!agentWs || agentWs.readyState !== agentWs.OPEN) {
        return res.status(503).json({ error: 'Device offline' });
    }
    
    const cmdId = uuidv4();
    const command = req.body.command;
    if (!command) return res.status(400).json({ error: 'Command required' });
    
    agentWs.send(JSON.stringify({ action: 'exec', cmdId, command }));
    
    let timeout;
    const handler = (msg) => {
        try {
            const data = JSON.parse(msg.toString());
            if (data.action === 'exec_result' && data.cmdId === cmdId) {
                clearTimeout(timeout);
                agentWs.removeListener('message', handler);
                res.json({ stdout: data.stdout || '', stderr: data.stderr || '', code: data.code });
            }
        } catch (e) {}
    };
    
    agentWs.on('message', handler);
    
    timeout = setTimeout(() => {
        agentWs.removeListener('message', handler);
        res.status(504).json({ error: 'Command timeout' });
    }, 30000);
});

app.get('/api/devices/:id/screenshot', (req, res) => {
    const d = deviceHub.getDeviceInfo(req.params.id);
    if (!d) return res.status(404).json({ error: 'Device not found' });
    if (!d.online) return res.status(503).json({ error: 'Device offline' });
    
    const agentWs = deviceHub.getAgentWs(req.params.id);
    if (!agentWs || agentWs.readyState !== agentWs.OPEN) {
        return res.status(503).json({ error: 'Device offline' });
    }
    
    const shotId = uuidv4();
    
    agentWs.send(JSON.stringify({ action: 'screenshot', shotId }));
    
    let timeout;
    const handler = (msg) => {
        try {
            const data = JSON.parse(msg.toString());
            if (data.action === 'screenshot_data' && data.shotId === shotId) {
                clearTimeout(timeout);
                agentWs.removeListener('message', handler);
                const imgBuffer = Buffer.from(data.data, 'base64');
                res.writeHead(200, { 'Content-Type': 'image/jpeg' });
                res.end(imgBuffer);
            }
        } catch (e) {}
    };
    
    agentWs.on('message', handler);
    
    timeout = setTimeout(() => {
        agentWs.removeListener('message', handler);
        res.status(504).json({ error: 'Screenshot timeout' });
    }, 10000);
});

// ========== WebSocket 服务器 ==========
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const deviceId = url.searchParams.get('device_id');
    
    console.log('WebSocket connected:', pathname, 'device_id:', deviceId);
    
    if (pathname === '/agent/register') {
        handleAgentRegister(ws, deviceId, req);
    } else if (pathname === '/api/v1/stream') {
        handleStreamSubscription(ws, deviceId);
    } else if (pathname === '/agent') {
        handleLegacyAgent(ws, req);
    } else if (pathname.startsWith('/relay/')) {
        const parts = pathname.split('/');
        const relayType = parts[2];
        const relayDeviceId = parts[3];
        handleLegacyRelay(ws, relayType, relayDeviceId);
    } else {
        ws.close(4000, 'Unknown endpoint');
    }
});

// Agent 注册路由：/agent/register?device_id=xxx
function handleAgentRegister(ws, deviceId, req) {
    let registeredDeviceId = deviceId || null;
    
    ws.on('message', (data) => {
        try {
            if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
                
                if (buf.length > 4 && buf.toString('utf8', 0, 4) === 'VIDE') {
                    const tsData = buf.slice(4);
                    deviceHub.broadcastBinary(registeredDeviceId, tsData);
                    return;
                }
                
                if (buf.length >= 4) {
                    const cmd = buf.readUInt16BE(0);
                    const cmdsize = buf.readUInt16BE(2);
                    if ((cmd === 3 || cmd === 7) && buf.length >= cmdsize) {
                        deviceHub.broadcastBinary(registeredDeviceId, buf);
                        return;
                    }
                }
                
                if (buf.length === 6 && buf[0] === 0x07) {
                    deviceHub.broadcastBinary(registeredDeviceId, data);
                    return;
                }
            }
            
            const msg = JSON.parse(data.toString());
            
            if (msg.action === 'register') {
                registeredDeviceId = msg.deviceId || deviceId || uuidv4();
                deviceHub.registerAgent(registeredDeviceId, ws, {
                    name: msg.name,
                    os: msg.os,
                    ip: msg.ip || req.socket.remoteAddress,
                    resolution: msg.resolution
                });
                ws.send(JSON.stringify({ action: 'registered', deviceId: registeredDeviceId }));
            } else if (msg.action === 'pong') {
                deviceHub.updateHeartbeat(registeredDeviceId);
            } else if (msg.action === 'exec_result' && registeredDeviceId) {
            } else if (msg.action === 'screenshot_data' && registeredDeviceId) {
            }
        } catch (e) {
            console.error('Agent message error:', e);
        }
    });
    
    ws.on('close', () => {
        if (registeredDeviceId) {
            deviceHub.unregisterAgent(registeredDeviceId);
        }
    });
    
    ws.on('error', () => {});
    
    const pingInterval = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ action: 'ping' }));
        } else {
            clearInterval(pingInterval);
        }
    }, 10000);
}

// 视频流订阅路由：/api/v1/stream?device_id=xxx
function handleStreamSubscription(ws, deviceId) {
    if (!deviceId) {
        ws.close(4000, 'device_id required');
        return;
    }
    
    const d = deviceHub.getDeviceInfo(deviceId);
    if (!d || !d.online) {
        ws.close(4001, 'Device offline');
        return;
    }
    
    deviceHub.addSubscriber(deviceId, ws);
    
    ws.on('message', (data) => {
        const agentWs = deviceHub.getAgentWs(deviceId);
        if (agentWs && agentWs.readyState === agentWs.OPEN) {
            try { agentWs.send(data); } catch(e) {}
        }
    });
    
    ws.on('close', () => {
        deviceHub.removeSubscriber(deviceId, ws);
        console.log('Stream subscriber disconnected:', deviceId);
    });
    
    ws.on('error', () => {});
}

// 兼容旧版 Agent 连接
function handleLegacyAgent(ws, req) {
    let deviceId = null;
    
    ws.on('message', (data) => {
        try {
            if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
                
                if (buf.length > 4 && buf.toString('utf8', 0, 4) === 'VIDE') {
                    const tsData = buf.slice(4);
                    deviceHub.broadcastBinary(deviceId, tsData);
                    return;
                }
                
                if (buf.length >= 4) {
                    const cmd = buf.readUInt16BE(0);
                    const cmdsize = buf.readUInt16BE(2);
                    if ((cmd === 3 || cmd === 7) && buf.length >= cmdsize) {
                        deviceHub.broadcastBinary(deviceId, buf);
                        return;
                    }
                }
                
                if (buf.length === 6 && buf[0] === 0x07) {
                    deviceHub.broadcastBinary(deviceId, data);
                    return;
                }
            }
            
            const msg = JSON.parse(data.toString());
            
            if (msg.action === 'register') {
                deviceId = msg.deviceId || uuidv4();
                deviceHub.registerAgent(deviceId, ws, {
                    name: msg.name,
                    os: msg.os,
                    ip: msg.ip || req.socket.remoteAddress,
                    resolution: msg.resolution
                });
                ws.send(JSON.stringify({ action: 'registered', deviceId }));
            } else if (msg.action === 'pong') {
                deviceHub.updateHeartbeat(deviceId);
            } else if (msg.action === 'exec_result' && deviceId) {
            } else if (msg.action === 'screenshot_data' && deviceId) {
            }
        } catch (e) {
            console.error('Legacy agent message error:', e);
        }
    });
    
    ws.on('close', () => {
        if (deviceId) {
            deviceHub.unregisterAgent(deviceId);
        }
    });
    
    ws.on('error', () => {});
    
    const pingInterval = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ action: 'ping' }));
        } else {
            clearInterval(pingInterval);
        }
    }, 10000);
}

// 兼容旧版中继连接
function handleLegacyRelay(ws, relayType, deviceId) {
    console.log('Legacy relay connection:', relayType, deviceId);
    
    const d = deviceHub.getDeviceInfo(deviceId);
    if (!d || !d.online) {
        ws.close(4001, 'Device offline');
        return;
    }
    
    const agentWs = deviceHub.getAgentWs(deviceId);
    if (!agentWs || agentWs.readyState !== agentWs.OPEN) {
        ws.close(4001, 'Device offline');
        return;
    }
    
    deviceHub.addSubscriber(deviceId, ws);
    
    ws.on('message', (data) => {
        const agentWs = deviceHub.getAgentWs(deviceId);
        if (agentWs && agentWs.readyState === agentWs.OPEN) {
            try { agentWs.send(data); } catch(e) {}
        }
    });
    
    ws.on('close', () => {
        deviceHub.removeSubscriber(deviceId, ws);
        console.log('Legacy relay disconnected:', deviceId);
    });
    
    ws.on('error', () => {});
}

// ========== 启动 ==========
const PORT = process.env.PORT || 8443;
server.listen(PORT, '::', () => {
    console.log(`Exhibition Remote Control Server running on https://[::]:${PORT}`);
    console.log(`Web UI: https://localhost:${PORT}`);
});