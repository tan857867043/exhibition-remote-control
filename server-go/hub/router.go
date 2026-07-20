package hub

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"

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
	http.HandleFunc("/api/v1/agent/download", corsMiddleware(handleAgentDownload))
	http.HandleFunc("/api/v1/stream", handleStreamSubscribe)
	http.HandleFunc("/api/v1/control", corsMiddleware(handleExternalControl))
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
	deviceMAC := cleanMAC(r.URL.Query().Get("mac"))
	deviceIP, _, _ := net.SplitHostPort(r.RemoteAddr)
	if deviceIP == "" {
		deviceIP = r.RemoteAddr
	}
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
			if len(payload) > 9 && payload[0] == 0x02 { // 0x02 indicates full frame
				GlobalHub.mu.Lock()
				// Extract JPEG bytes (skip 9 bytes header)
				jpegBytes := make([]byte, len(payload)-9)
				copy(jpegBytes, payload[9:])
				GlobalHub.LatestFrame[deviceID] = jpegBytes
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
	deviceID := r.URL.Query().Get("device_id")

	GlobalHub.mu.Lock()
	if GlobalHub.Subscribers[deviceID] == nil {
		GlobalHub.Subscribers[deviceID] = make(map[*websocket.Conn]bool)
	}
	GlobalHub.Subscribers[deviceID][conn] = true
	GlobalHub.mu.Unlock()

	defer func() {
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

		// 将客户端发来的 WebSocket 文本消息（控制指令）透传给 Agent，降低控制延迟
		if messageType == websocket.TextMessage {
			GlobalHub.mu.RLock()
			agentConn, exists := GlobalHub.Agents[deviceID]
			GlobalHub.mu.RUnlock()
			if exists {
				agentConn.WriteMessage(websocket.TextMessage, payload)
			}
		}
	}
}

func handleAgentDownload(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile("static/exhibition-agent.exe")
	if err != nil {
		http.Error(w, "failed to read agent binary: "+err.Error(), http.StatusInternalServerError)
		return
	}

	lanIP := detectLANIP()
	if lanIP == "" {
		http.Error(w, "failed to detect LAN IP", http.StatusInternalServerError)
		return
	}

	serverURL := fmt.Sprintf("ws://%s:38921", lanIP)
	// 在 exe 尾部追加配置块（PE 加载器忽略尾部数据）
	tail := fmt.Sprintf("\n---EXHIBITION_CONF---\nserver=%s\n", serverURL)

	modified := make([]byte, len(data)+len(tail))
	copy(modified, data)
	copy(modified[len(data):], tail)

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="exhibition-agent.exe"`)
	w.Write(modified)
}

func detectLANIP() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}

	var fallbackIP string
	var ip192, ip10, ip172 string

	for _, iface := range ifaces {
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipNet.IP
			if ip.IsLoopback() {
				continue
			}
			ip4 := ip.To4()
			if ip4 == nil {
				continue
			}
			ipStr := ip4.String()

			if fallbackIP == "" {
				fallbackIP = ipStr
			}

			if len(ipStr) >= 8 && ipStr[:8] == "192.168." {
				ip192 = ipStr
			} else if ipStr[:3] == "10." {
				ip10 = ipStr
			} else if len(ipStr) >= 4 && ipStr[:4] == "172." {
				ip172 = ipStr
			}
		}
	}

	// 优先级: 192.168 > 10. > 172. > 任意
	if ip192 != "" {
		return ip192
	}
	if ip10 != "" {
		return ip10
	}
	if ip172 != "" {
		return ip172
	}
	return fallbackIP
}

// cleanMAC converts Rust debug format MacAddr([216, 94, ...]) to D8:5E:D3:A3:17:62
func cleanMAC(raw string) string {
	// Remove "MacAddr([" prefix and "])" suffix
	inner := strings.TrimPrefix(raw, "MacAddr([")
	inner = strings.TrimSuffix(inner, "])")
	if inner == raw {
		return raw // not Rust debug format, return as-is
	}
	parts := strings.Split(inner, ",")
	if len(parts) != 6 {
		return raw
	}
	var out [6]byte
	for i, p := range parts {
		v, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil {
			return raw
		}
		out[i] = byte(v)
	}
	return fmt.Sprintf("%02X:%02X:%02X:%02X:%02X:%02X",
		out[0], out[1], out[2], out[3], out[4], out[5])
}
