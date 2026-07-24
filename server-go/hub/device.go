package hub

import (
	"sync"
	"github.com/gorilla/websocket"
)

type DeviceInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	OS   string `json:"os"`
	IP   string `json:"ip"`
	CPU  string `json:"cpu"`
	RAM  string `json:"ram"`
	MAC  string `json:"mac"`
}

// Subscriber 封装每个订阅者的 WebSocket 连接和写入通道
type Subscriber struct {
	Conn *websocket.Conn
	Ch   chan []byte // 待发送画面数据通道，关闭时通知写 goroutine 退出
}

// 核心状态数据结构：维护设备通道与订阅者的广播池
type DeviceHub struct {
	mu          sync.RWMutex
	Agents      map[string]*websocket.Conn          // 存放 Rust 被控端的 WS 连接
	DeviceInfos map[string]DeviceInfo               // 存放设备信息
	LatestFrame map[string][]byte                   // 存放最新一帧完整的画面作为缩略图
	Subscribers map[string]map[*websocket.Conn]*Subscriber // 存放订阅特定设备画面流的第三方应用连接
}

var GlobalHub = &DeviceHub{
	Agents:      make(map[string]*websocket.Conn),
	DeviceInfos: make(map[string]DeviceInfo),
	LatestFrame: make(map[string][]byte),
	Subscribers: make(map[string]map[*websocket.Conn]*Subscriber),
}

