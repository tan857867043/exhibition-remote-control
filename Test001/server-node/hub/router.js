
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const os = require('os');
const { GlobalHub } = require('./device-hub');
const { streamExeWithConfig, getAgentFilePath } = require('./exe-config');

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function initWSServer(server) {
  const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: true });

  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  // 被控端连接
  wss.on('connection', (ws, req) => {
    console.log(`WebSocket连接: ${req.url}`);
    if (req.url.includes('/agent/register')) {
      const params = new URLSearchParams(req.url.split('?')[1]);
      const deviceId = params.get('device_id');
      console.log(`Agent注册请求: device_id=${deviceId}`);
      if (!deviceId) return ws.close(1008, "invalid device id");

      const ip = req.socket.remoteAddress;
      GlobalHub.registerAgent(deviceId, ip, ws);

      ws.on('message', (data) => {
        // 心跳处理
        if (data.toString() === 'ping') {
          GlobalHub.updateHeartbeat(deviceId);
          return ws.send('pong');
        }

        // 二进制画面转发
        if (Buffer.isBuffer(data)) {
          GlobalHub.broadcastBinary(deviceId, data);
          return;
        }

        // 普通文本信令 / CMD终端指令回包 / 遥测数据
        try { 
          const msg = JSON.parse(data);
          GlobalHub.updateHeartbeat(deviceId);
          if (msg.action === 'register') {
            GlobalHub.updateDeviceInfo(deviceId, { name: msg.name, os_name: msg.os });
          }
          if (msg.action === 'telemetry') {
            GlobalHub.updateDeviceTelemetry(deviceId, msg);
          }
          // 转发文本消息到订阅者（如遥测、终端输出）
          GlobalHub.broadcastText(deviceId, data);
        } catch (e) {}
      });

      ws.on('close', () => GlobalHub.unregisterAgent(deviceId));
      ws.on('error', () => GlobalHub.unregisterAgent(deviceId));
    }

    // 画面订阅连接
    else if (req.url.includes('/api/v1/stream')) {
      const params = new URLSearchParams(req.url.split('?')[1]);
      const deviceId = params.get('device_id');
      console.log(`画面订阅请求: device_id=${deviceId}`);
      if (!deviceId) return ws.close(1008, "invalid device id");

      GlobalHub.addSubscriber(deviceId, ws);
      console.log(`流订阅成功: ${deviceId}, subscribers=${GlobalHub.subscribers.get(deviceId)?.size}`);
      
      // 浏览器→agent 消息转发（键鼠指令、质量调整等）
      ws.on('message', (data) => {
        if (Buffer.isBuffer(data) && data.length <= 10) {
          console.log(`input relay: ${deviceId}, len=${data.length}, type=0x${data[0]?.toString(16)}`);
        }
        GlobalHub.sendCmdPriority(deviceId, data);
      });
      
      ws.on('close', (code, reason) => {
        console.log(`流断开: ${deviceId}, code=${code}, reason=${reason?.toString()||'none'}`);
        GlobalHub.removeSubscriber(deviceId, ws);
      });
      ws.on('error', (err) => {
        console.log(`流错误: ${deviceId}, error=${err.message}`);
        GlobalHub.removeSubscriber(deviceId, ws);
      });
    }
  });

  return wss;
}

function handleApi(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.writeHead(200), res.end();

  // 设备列表
  if (req.url === '/api/v1/devices' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(GlobalHub.listDevices()));
  }

  // Agent 下载端点
  if (req.url.startsWith('/agents') && req.method === 'GET') {
    const agentPath = getAgentFilePath();
    if (!agentPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Agent executable not found');
    }

    const params = new URLSearchParams(req.url.split('?')[1]);
    let serverUrl = params.get('server');
    
    if (!serverUrl) {
      const host = req.headers.host || '';
      const port = host.includes(':') ? host.split(':')[1] : '80';
      const localIP = getLocalIP();
      serverUrl = `http://${localIP}:${port}`;
    }

    const config = {
      server_url: serverUrl,
      device_name: params.get('name') || undefined,
      width: params.get('width') ? parseInt(params.get('width')) : undefined,
      height: params.get('height') ? parseInt(params.get('height')) : undefined,
    };

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="exhibition-agent.exe"',
    });

    console.log(`Agent download requested, server_url: ${config.server_url}`);
    
    try {
      streamExeWithConfig({
        sourceFileName: agentPath,
        destinationStream: res,
        config: config,
      });
    } catch (e) {
      console.error('Agent download error:', e);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
    }
    return;
  }

  // 通用控制指令下发（键鼠 + CMD终端指令）
  if (req.url === '/api/v1/control' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const cmd = JSON.parse(body);
        const ok = GlobalHub.sendCmdPriority(cmd.device_id, JSON.stringify(cmd));
        if (ok) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: "success" }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: "device offline" }));
        }
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: "server error" }));
      }
    });
    return;
  }

  // 静态文件服务：非 API 请求返回前端页面
  const frontendDir = path.join(__dirname, '..', 'public');
  let filePath = path.join(frontendDir, req.url === '/' ? 'index.html' : req.url);
  
  // 安全检查：防止路径遍历
  if (!filePath.startsWith(frontendDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  
  const ext = path.extname(filePath);
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
  };
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } else {
      res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
      res.end(data);
    }
  });
}

module.exports = { initWSServer, handleApi };
