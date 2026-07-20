package hub

import (
	"sync"
	"github.com/gorilla/websocket"
)

// 核心状态数据结构：维护设备通道与订阅者的广播池
type DeviceHub struct {
	mu          sync.RWMutex
	Agents      map[string]*websocket.Conn          // 存放 Rust 被控端的 WS 连接
	Subscribers map[string]map[*websocket.Conn]bool // 存放订阅特定设备画面流的第三方应用连接
}

var GlobalHub = &DeviceHub{
	Agents:      make(map[string]*websocket.Conn),
	Subscribers: make(map[string]map[*websocket.Conn]bool),
}
