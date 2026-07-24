
const now = () => new Date().toISOString();

// 心跳全局配置
const HEARTBEAT_INTERVAL = 10000;
const HEARTBEAT_TIMEOUT = 30000;

class DeviceHub {
  constructor() {
    this.agents = new Map();
    this.subscribers = new Map();
    this.deviceInfos = new Map();
    this.heartbeatMap = new Map();

    // UU优化：双队列隔离（指令优先、画面后置）
    this.frameQueue = new Map();
    this.cmdQueue = new Map();

    this.initHeartbeatCheck();
  }

  registerAgent(deviceId, ip, ws) {
    this.agents.set(deviceId, ws);
    this.deviceInfos.set(deviceId, {
      device_id: deviceId,
      ip_address: ip,
      connected_at: now(),
      status: "active"
    });
    this.heartbeatMap.set(deviceId, Date.now());
    this.frameQueue.set(deviceId, null);
    console.log(`设备上线：${deviceId}，IP：${ip}`);
  }

  updateHeartbeat(deviceId) {
    if (this.heartbeatMap.has(deviceId)) {
      this.heartbeatMap.set(deviceId, Date.now());
    }
  }

  initHeartbeatCheck() {
    setInterval(() => {
      const nowTime = Date.now();
      for (const [deviceId, lastTime] of this.heartbeatMap) {
        if (nowTime - lastTime > HEARTBEAT_TIMEOUT) {
          const ws = this.agents.get(deviceId);
          if (ws && ws.readyState === ws.OPEN) ws.close(1011, "heartbeat timeout");
          this.unregisterAgent(deviceId);
          console.log(`设备心跳离线：${deviceId}`);
        }
      }
    }, 5000);
  }

  unregisterAgent(deviceId) {
    this.agents.delete(deviceId);
    this.deviceInfos.delete(deviceId);
    this.heartbeatMap.delete(deviceId);
    this.subscribers.delete(deviceId);
    this.frameQueue.delete(deviceId);
    this.cmdQueue.delete(deviceId);
  }

  addSubscriber(deviceId, ws) {
    if (!this.subscribers.has(deviceId)) this.subscribers.set(deviceId, new Set());
    const wasEmpty = this.subscribers.get(deviceId).size === 0;
    this.subscribers.get(deviceId).add(ws);
    
    if (wasEmpty) {
      const agentWs = this.agents.get(deviceId);
      if (agentWs && agentWs.readyState === 1) {
        agentWs.send(JSON.stringify({ action: "desktop_start" }));
        console.log(`发送 desktop_start 到 ${deviceId}`);
      }
    }
  }

  removeSubscriber(deviceId, ws) {
    if (!this.subscribers.has(deviceId)) return;
    const s = this.subscribers.get(deviceId);
    s.delete(ws);
    if (s.size === 0) {
      this.subscribers.delete(deviceId);
      const agentWs = this.agents.get(deviceId);
      if (agentWs && agentWs.readyState === 1) {
        agentWs.send(JSON.stringify({ action: "desktop_stop" }));
        console.log(`发送 desktop_stop 到 ${deviceId}`);
      }
    }
  }

  getAgentConn(deviceId) {
    return this.agents.get(deviceId) || null;
  }

  listDevices() {
    return Array.from(this.deviceInfos.values());
  }

  broadcastBinary(deviceId, data) {
    if (!this.subscribers.has(deviceId)) {
      return;
    }
    const count = this.subscribers.get(deviceId).size;
    this.subscribers.get(deviceId).forEach(ws => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    });
    if (data[0] === 0x04 || data[0] === 0x03) {
      console.log(`broadcast: ${deviceId}, type=0x${data[0].toString(16)}, size=${data.length}, subs=${count}`);
    }
    if (data[0] === 0x05) {
      console.log(`broadcast cursor: ${deviceId}, size=${data.length}, subs=${count}`);
    }
  }

  broadcastText(deviceId, data) {
    if (!this.subscribers.has(deviceId)) return;
    const text = typeof data === 'string' ? data : data.toString();
    this.subscribers.get(deviceId).forEach(ws => {
      if (ws.readyState === ws.OPEN) {
        ws.send(text);
      }
    });
  }

  updateDeviceTelemetry(deviceId, info) {
    const existing = this.deviceInfos.get(deviceId);
    if (existing) {
      existing.cpu = info.cpu || existing.cpu;
      existing.os_name = info.os || existing.os_name;
      existing.mac = info.mac || existing.mac;
      existing.cpu_usage = info.cpu_usage || existing.cpu_usage;
      existing.ram_total = info.ram_total || existing.ram_total;
    }
  }

  updateDeviceInfo(deviceId, info) {
    const existing = this.deviceInfos.get(deviceId);
    if (existing) {
      if (info.name) existing.name = info.name;
      if (info.os_name) existing.os_name = info.os_name;
    }
  }

  // UU优化：指令优先推送（键鼠/CMD终端指令通用）
  sendCmdPriority(deviceId, data) {
    const ws = this.getAgentConn(deviceId);
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(data);
      return true;
    }
    console.log(`sendCmdPriority failed: deviceId=${deviceId}, hasWs=${!!ws}, readyState=${ws?.readyState}`);
    return false;
  }
}

const GlobalHub = new DeviceHub();
module.exports = { GlobalHub, HEARTBEAT_INTERVAL, HEARTBEAT_TIMEOUT };
