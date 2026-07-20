package hub

import (
	"encoding/json"
	"log"
	"net/http"

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
	if deviceID == "" {
		conn.Close()
		return
	}

	GlobalHub.mu.Lock()
	GlobalHub.Agents[deviceID] = conn
	GlobalHub.mu.Unlock()

	defer func() {
		GlobalHub.mu.Lock()
		delete(GlobalHub.Agents, deviceID)
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
	list := make([]string, 0, len(GlobalHub.Agents))
	for k := range GlobalHub.Agents {
		list = append(list, k)
	}
	GlobalHub.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(list)
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

	// 挂起连接持续等待监听退订事件
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			break
		}
	}
}
