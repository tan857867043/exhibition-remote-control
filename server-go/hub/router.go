package hub

import (
	"encoding/binary"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func corsMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next(w, r)
	}
}

func InitRouter() {
	// 1. Rust Agent 接入通道
	http.HandleFunc("/agent/register", handleAgentRegister)

	// 2. 面向第三方系统的开放 API 接口
	http.HandleFunc("/api/v1/devices", corsMiddleware(handleListDevices))
	http.HandleFunc("/api/v1/devices/thumbnail", corsMiddleware(handleThumbnail))
	http.HandleFunc("/api/v1/stream", handleStreamSubscribe)
	http.HandleFunc("/api/v1/control", corsMiddleware(handleExternalControl))
	http.HandleFunc("/agents", corsMiddleware(handleAgentDownload))
}

// 接收 Rust Agent 的画面数据并高效流式分发给所有第三方订阅者
func handleAgentRegister(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade error:", err)
		return
	}
	deviceID := r.URL.Query().Get("device_id")
	deviceName := r.URL.Query().Get("device_name")
	deviceOS := r.URL.Query().Get("os")
	deviceCPU := r.URL.Query().Get("cpu")
	deviceRAM := r.URL.Query().Get("ram")
	deviceMAC := r.URL.Query().Get("mac")
	deviceIP := r.RemoteAddr
	if deviceID == "" {
		conn.Close()
		return
	}

	GlobalHub.mu.Lock()
	GlobalHub.Agents[deviceID] = conn
	GlobalHub.DeviceInfos[deviceID] = DeviceInfo{
		ID:   deviceID,
		Name: deviceName,
		OS:   deviceOS,
		IP:   deviceIP,
		CPU:  deviceCPU,
		RAM:  deviceRAM,
		MAC:  deviceMAC,
	}
	GlobalHub.mu.Unlock()

	defer func() {
		GlobalHub.mu.Lock()
		delete(GlobalHub.Agents, deviceID)
		delete(GlobalHub.DeviceInfos, deviceID)
		GlobalHub.mu.Unlock()
		conn.Close()
	}()

	for {
		// 极速读取 Rust 发来的自定义二进制画面包，零解析，直接以字节数组形态向外广播
		messageType, payload, err := conn.ReadMessage()
		if err != nil {
			break
		}

		if messageType == websocket.BinaryMessage {
			if len(payload) > 14 && (payload[0] == 0x02 || payload[0] == 0x03 || payload[0] == 0x04) {
				GlobalHub.mu.Lock()
				// 保存完整帧（含 14 字节头），供新订阅者连接时直接推送
				frame := make([]byte, len(payload))
				copy(frame, payload)
				GlobalHub.LatestFrame[deviceID] = frame
				GlobalHub.mu.Unlock()
			}
			GlobalHub.mu.RLock()
			subs := GlobalHub.Subscribers[deviceID]
			for subConn := range subs {
				// 异步无阻塞流式转发原始二进制画面块
				err := subConn.WriteMessage(websocket.BinaryMessage, payload)
				if err != nil {
					log.Println("Write error to sub:", err)
				}
			}
			GlobalHub.mu.RUnlock()
		} else if messageType == websocket.TextMessage {
			displayLen := len(payload)
			if displayLen > 200 {
				displayLen = 200
			}
			log.Printf("[Hub] Agent %s sent text: %s", deviceID, string(payload[:displayLen]))
			GlobalHub.mu.RLock()
			subs := GlobalHub.Subscribers[deviceID]
			log.Printf("[Hub] Forwarding text to %d subscribers", len(subs))
			for subConn := range subs {
				subConn.WriteMessage(websocket.TextMessage, payload)
			}
			GlobalHub.mu.RUnlock()
		}
	}
}

// 接收外部控制 API 的 JSON 请求，直接秒级透传至 Rust 被控端执行物理模拟
func handleExternalControl(w http.ResponseWriter, r *http.Request) {
	// 确保任何情况下都有响应（避免浏览器 ERR_EMPTY_RESPONSE）
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		w.Write([]byte(`{"error":"method not allowed"}`))
		return
	}
	var cmd map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&cmd); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"invalid json"}`))
		return
	}

	deviceID, ok := cmd["device_id"].(string)
	if !ok {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"missing device_id"}`))
		return
	}

	// 先写 HTTP 响应（保证浏览器不报 ERR_EMPTY_RESPONSE），再异步透传到 agent
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"success"}`))

	GlobalHub.mu.RLock()
	agentConn, exists := GlobalHub.Agents[deviceID]
	GlobalHub.mu.RUnlock()

	if exists {
		bytes, _ := json.Marshal(cmd)
		agentConn.WriteMessage(websocket.TextMessage, bytes)
	}
}

func handleListDevices(w http.ResponseWriter, r *http.Request) {
	GlobalHub.mu.RLock()
	list := make([]DeviceInfo, 0, len(GlobalHub.DeviceInfos))
	for _, info := range GlobalHub.DeviceInfos {
		if info.Name == "" {
			info.Name = info.ID
		}
		list = append(list, info)
	}
	GlobalHub.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(list)
}

func handleThumbnail(w http.ResponseWriter, r *http.Request) {
	deviceID := r.URL.Query().Get("device_id")
	if deviceID == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	GlobalHub.mu.RLock()
	frame, exists := GlobalHub.LatestFrame[deviceID]
	GlobalHub.mu.RUnlock()

	if !exists || len(frame) < 15 {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte("Thumbnail not available yet"))
		return
	}

	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	// 跳过 14 字节头，输出纯 JPEG 数据
	w.Write(frame[14:])
}

func handleStreamSubscribe(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade error:", err)
		return
	}
	deviceID := r.URL.Query().Get("device_id")

	GlobalHub.mu.Lock()
	wasEmpty := len(GlobalHub.Subscribers[deviceID]) == 0
	if GlobalHub.Subscribers[deviceID] == nil {
		GlobalHub.Subscribers[deviceID] = make(map[*websocket.Conn]bool)
	}
	GlobalHub.Subscribers[deviceID][conn] = true
	GlobalHub.mu.Unlock()

	// 第一个订阅者连接时通知 Agent 恢复截图
	if wasEmpty {
		GlobalHub.mu.RLock()
		agentConn, exists := GlobalHub.Agents[deviceID]
		GlobalHub.mu.RUnlock()
		if exists {
			agentConn.WriteMessage(websocket.TextMessage, []byte(`{"action":"resume"}`))
		}
	}

	// 订阅时立即推送最新缓存帧，确保被控端画面静止时控制窗口也能显示画面
	GlobalHub.mu.RLock()
	latestFrame := GlobalHub.LatestFrame[deviceID]
	GlobalHub.mu.RUnlock()
	if latestFrame != nil {
		conn.WriteMessage(websocket.BinaryMessage, latestFrame)
	}

	defer func() {
		var becameEmpty bool
		GlobalHub.mu.Lock()
		if GlobalHub.Subscribers[deviceID] != nil {
			delete(GlobalHub.Subscribers[deviceID], conn)
			if len(GlobalHub.Subscribers[deviceID]) == 0 {
				delete(GlobalHub.Subscribers, deviceID)
				becameEmpty = true
			}
		}
		GlobalHub.mu.Unlock()
		conn.Close()

		// 最后一个订阅者离开时通知 Agent 暂停截图
		if becameEmpty {
			GlobalHub.mu.RLock()
			agentConn, exists := GlobalHub.Agents[deviceID]
			GlobalHub.mu.RUnlock()
			if exists {
				agentConn.WriteMessage(websocket.TextMessage, []byte(`{"action":"pause"}`))
			}
		}
	}()

	// 挂起连接持续等待监听退订事件和控制指令
	for {
		messageType, payload, err := conn.ReadMessage()
		if err != nil {
			break
		}

		// 将客户端发来的 WebSocket 文本消息（控制指令）透传给 Agent，降低控制延迟
		if messageType == websocket.TextMessage || messageType == websocket.BinaryMessage {
			if messageType == websocket.TextMessage {
				displayLen := len(payload)
				if displayLen > 200 {
					displayLen = 200
				}
				log.Printf("[Hub] Subscriber for %s sent text: %s", deviceID, string(payload[:displayLen]))
			}
			GlobalHub.mu.RLock()
			agentConn, exists := GlobalHub.Agents[deviceID]
			GlobalHub.mu.RUnlock()
			if exists {
				agentConn.WriteMessage(messageType, payload)
			} else {
				log.Printf("[Hub] Agent %s not found, cannot forward message", deviceID)
			}
		}
	}
}

var exeConfigGUID = []byte{0xB9, 0x96, 0x01, 0x58, 0x80, 0x54, 0x4A, 0x19, 0xB7, 0xF7, 0xE9, 0xBE, 0x44, 0x91, 0x4C, 0x18}

func getLocalIP() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "127.0.0.1"
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip != nil && ip.To4() != nil {
				return ip.String()
			}
		}
	}
	return "127.0.0.1"
}

func handleAgentDownload(w http.ResponseWriter, r *http.Request) {
	exePath := filepath.Join("..", "agent-rust", "target", "release", "exhibition-agent.exe")
	if _, err := os.Stat(exePath); os.IsNotExist(err) {
		exePath = filepath.Join("..", "agent-rust", "target", "debug", "exhibition-agent.exe")
		if _, err := os.Stat(exePath); os.IsNotExist(err) {
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte("Agent exe not found"))
			return
		}
	}

	host := r.URL.Query().Get("server")
	if host == "" {
		host = r.Host
	}
	port := "38921"
	if h, p, err := net.SplitHostPort(host); err == nil {
		host = h
		port = p
	}
	if host == "localhost" || host == "127.0.0.1" || host == "" {
		host = getLocalIP()
	}
	host = net.JoinHostPort(host, port)

	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	configJSON, _ := json.Marshal(map[string]string{"server_url": scheme + "://" + host})

	exeData, err := os.ReadFile(exePath)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename=\"exhibition-agent.exe\"")
	w.Write(exeData)
	w.Write(configJSON)
	binary.Write(w, binary.BigEndian, uint32(len(configJSON)))
	w.Write(exeConfigGUID)
}
