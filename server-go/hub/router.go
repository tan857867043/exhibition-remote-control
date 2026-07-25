package hub

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
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
	if tcp, ok := conn.UnderlyingConn().(*net.TCPConn); ok {
		tcp.SetNoDelay(true)
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

	defer func() {
		if r := recover(); r != nil {
			log.Printf("Recovered from agent handler panic: %v", r)
		}
	}()

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
			if len(payload) > 14 && (payload[0] == 0x02 || payload[0] == 0x04) { // 0x02 or 0x04 indicates full frame
				GlobalHub.mu.Lock()
				// Extract JPEG bytes (skip 14 bytes header)
				jpegBytes := make([]byte, len(payload)-14)
				copy(jpegBytes, payload[14:])
				GlobalHub.LatestFrame[deviceID] = jpegBytes
				GlobalHub.mu.Unlock()
			}
			GlobalHub.mu.RLock()
			subs := GlobalHub.Subscribers[deviceID]
			for _, sub := range subs {
				// 非阻塞推送到通道；通道满时丢掉最旧帧让位给最新帧
				select {
				case sub.Ch <- payload:
				default:
					// 缓冲满：主动 drain 一条旧帧腾位置，确保最新帧不被丢弃
					select {
					case <-sub.Ch:
					default:
					}
					sub.Ch <- payload
				}
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

	if !exists || len(frame) == 0 {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte("Thumbnail not available yet"))
		return
	}

	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Write(frame)
}

func handleStreamSubscribe(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade error:", err)
		return
	}
	if tcp, ok := conn.UnderlyingConn().(*net.TCPConn); ok {
		tcp.SetNoDelay(true)
	}
	deviceID := r.URL.Query().Get("device_id")

	defer func() {
		if r := recover(); r != nil {
			log.Printf("Recovered from subscriber handler panic: %v", r)
		}
	}()

	// 创建订阅者：带缓冲通道 + 专用写 goroutine（避免 goroutine 爆炸和写锁竞争）
	sub := &Subscriber{
		Conn: conn,
		Ch:   make(chan []byte, 16), // 16 帧缓冲，满则丢帧
	}

	GlobalHub.mu.Lock()
	if GlobalHub.Subscribers[deviceID] == nil {
		GlobalHub.Subscribers[deviceID] = make(map[*websocket.Conn]*Subscriber)
	}
	GlobalHub.Subscribers[deviceID][conn] = sub
	GlobalHub.mu.Unlock()

	// 专用写 goroutine：顺序读取通道消息并写入 WebSocket
	go func() {
		for data := range sub.Ch {
			conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
				break
			}
		}
		// 通道关闭时退出
	}()

	defer func() {
		close(sub.Ch)
		GlobalHub.mu.Lock()
		if GlobalHub.Subscribers[deviceID] != nil {
			delete(GlobalHub.Subscribers[deviceID], conn)
			if len(GlobalHub.Subscribers[deviceID]) == 0 {
				delete(GlobalHub.Subscribers, deviceID)
			}
		}
		GlobalHub.mu.Unlock()
		conn.Close()
	}()

	// 挂起连接持续等待监听退订事件和控制指令
	for {
		messageType, payload, err := conn.ReadMessage()
		if err != nil {
			break
		}

		if messageType == websocket.TextMessage || messageType == websocket.BinaryMessage {
			GlobalHub.mu.RLock()
			agentConn, exists := GlobalHub.Agents[deviceID]
			GlobalHub.mu.RUnlock()
			if exists {
				agentConn.WriteMessage(messageType, payload)
			}
		}
	}
}

func handleAgentDownload(w http.ResponseWriter, r *http.Request) {
	exePath := filepath.Join("..", "agent-rust", "target", "release", "exhibition-agent.exe")
	if _, err := os.Stat(exePath); os.IsNotExist(err) {
		exePath = filepath.Join("..", "agent-rust", "target", "debug", "exhibition-agent.exe")
		if _, err := os.Stat(exePath); os.IsNotExist(err) {
			w.WriteHeader(http.StatusNotFound)
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
	serverURL := scheme + "://" + host

	cfg := map[string]string{"server_url": serverURL}
	if deviceName := r.URL.Query().Get("device_name"); deviceName != "" {
		cfg["device_name"] = deviceName
	}
	configJSON, _ := json.Marshal(cfg)

	exeFile, err := os.Open(exePath)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	defer exeFile.Close()

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="exhibition-agent.exe"`)

	io.Copy(w, exeFile)
	w.Write(configJSON)
	lenBuf := make([]byte, 4)
	binary.BigEndian.PutUint32(lenBuf, uint32(len(configJSON)))
	w.Write(lenBuf)
	w.Write(exeConfigGUID)
}
