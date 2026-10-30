package hub

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"regexp"
	"runtime"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// AgentDownloadData 由 main.go 通过 embed 设置，供 handleAgentDownload 使用
var AgentDownloadData []byte

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// ── 健康检查相关 ──
var (
	serverStartTime  time.Time
	errorCounterMu   sync.Mutex
	errorsLastMinute int64
)

func init() {
	serverStartTime = time.Now()
	go resetErrorCounterLoop()
}

func resetErrorCounterLoop() {
	for {
		time.Sleep(time.Minute)
		errorCounterMu.Lock()
		errorsLastMinute = errorCounter
		errorCounter = 0
		errorCounterMu.Unlock()
	}
}

var errorCounter int64

func incrementErrorCounter() {
	atomic.AddInt64(&errorCounter, 1)
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	errorCounterMu.Lock()
	errs := errorsLastMinute
	errorCounterMu.Unlock()

	GlobalHub.mu.RLock()
	connectedDevices := len(GlobalHub.Agents)
	GlobalHub.mu.RUnlock()

	resp := map[string]interface{}{
		"status":             "ok",
		"version":            "1.0.0",
		"uptime_seconds":     int(time.Since(serverStartTime).Seconds()),
		"connected_devices":  connectedDevices,
		"goroutine_count":    runtime.NumGoroutine(),
		"memory_mb":          m.Alloc / (1024 * 1024),
		"errors_last_minute": errs,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// ── Panic 恢复中间件 ──
func recoveryMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[Recovery] PANIC: %v\n%s", rec, debug.Stack())
				incrementErrorCounter()
				http.Error(w, "Internal Server Error", http.StatusInternalServerError)
			}
		}()
		next(w, r)
	}
}

// ── 设备 ID 验证 ──
var deviceIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

func validateDeviceID(id string) bool {
	if id == "" {
		return false
	}
	if len(id) > 64 {
		return false
	}
	return deviceIDPattern.MatchString(id)
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
	GlobalHub.DeviceStorage = loadDeviceStorage()
	restorePersistedDevices()

	// 0. 健康检查
	http.HandleFunc("/api/v1/health", recoveryMiddleware(handleHealth))

	// 1. Rust Agent 接入通道
	http.HandleFunc("/agent/register", recoveryMiddleware(handleAgentRegister))

	// 2. 面向第三方系统的开放 API 接口
	http.HandleFunc("/api/v1/devices", recoveryMiddleware(corsMiddleware(handleListDevices)))
	http.HandleFunc("/api/v1/devices/thumbnail", recoveryMiddleware(corsMiddleware(handleThumbnail)))
	http.HandleFunc("/api/v1/stream", recoveryMiddleware(handleStreamSubscribe))
	http.HandleFunc("/api/v1/terminal", recoveryMiddleware(handleTerminalSubscribe))
	http.HandleFunc("/api/v1/control", recoveryMiddleware(corsMiddleware(handleExternalControl)))
	http.HandleFunc("/agents", recoveryMiddleware(corsMiddleware(handleAgentDownload)))

	// 3. 设备管理 API
	http.HandleFunc("/api/v1/devices/discovered", recoveryMiddleware(corsMiddleware(handleDiscoveredDevices)))
	http.HandleFunc("/api/v1/devices/add", recoveryMiddleware(corsMiddleware(handleAddDevice)))
	http.HandleFunc("/api/v1/devices/remove", recoveryMiddleware(corsMiddleware(handleRemoveDevice)))
	http.HandleFunc("/api/v1/devices/rename", recoveryMiddleware(corsMiddleware(handleRenameDevice)))
	http.HandleFunc("/api/v1/devices/reorder", recoveryMiddleware(corsMiddleware(handleReorderDevices)))
	http.HandleFunc("/api/v1/devices/tags", recoveryMiddleware(corsMiddleware(handleUpdateTags)))

	// 4. 系统配置 API（远程修改被控端系统设置）
	http.HandleFunc("/api/v1/devices/system-config", recoveryMiddleware(corsMiddleware(handleSystemConfig)))
	http.HandleFunc("/api/v1/devices/wake", recoveryMiddleware(corsMiddleware(handleWake)))
}

// 接收 Rust Agent 的画面数据并高效流式分发给所有第三方订阅者
func handleAgentRegister(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[Hub] PANIC recovered in handleAgentRegister: %v", r)
		}
	}()
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade error:", err)
		return
	}
	conn.SetReadLimit(10 * 1024 * 1024) // 10MB，允许大文件分块
	conn.SetReadDeadline(time.Now().Add(60 * time.Second))

	deviceID := r.URL.Query().Get("device_id")
	deviceName := r.URL.Query().Get("device_name")
	deviceOS := r.URL.Query().Get("os")
	deviceCPU := r.URL.Query().Get("cpu")
	deviceRAM := r.URL.Query().Get("ram")
	deviceMac := r.URL.Query().Get("mac")
	deviceIP := r.RemoteAddr
	// 本机 Agent（通过 127.0.0.1/localhost 连接）时 RemoteAddr 是回环地址，
	// 设备详情会错误显示 127.0.0.1。检测到回环连接时改用 Hub 自身的局域网 IP。
	if h, _, err := net.SplitHostPort(deviceIP); err == nil {
		if ip := net.ParseIP(h); ip != nil && ip.IsLoopback() {
			deviceIP = GetLocalIP()
		}
	}
	if !validateDeviceID(deviceID) {
		conn.Close()
		return
	}

	// TCP_NODELAY: 降低网络延迟
	if tcp, ok := conn.UnderlyingConn().(*net.TCPConn); ok {
		tcp.SetNoDelay(true)
	}

	GlobalHub.mu.Lock()
	// 如果同一个 deviceID 重连：先关闭旧 writer，再注册新连接
	if old, existed := GlobalHub.Agents[deviceID]; existed {
		old.Close()
	}
	agent := &AgentConn{
		Conn:       conn,
		controlQ:   make(chan controlMsg, 256),
		payloadQ:   make(chan FrameMsg, 32),
		ResponseCh: make(chan []byte, 16),
		closeQ:     make(chan struct{}),
		deviceID:   deviceID,
	}
	GlobalHub.Agents[deviceID] = agent
	GlobalHub.mu.Unlock()
	// 启动「单 writer 协程」：所有向该 Agent 写的数据必须经 controlQ/payloadQ 串行化
	agent.StartWriter()

	// Agent 进入重连循环时会强制回到暂停态，而 resume 仅在「新订阅者连上」时下发。
	// 若 Agent 在有观众的情况下重连（网络抖动/服务重启/休眠唤醒），必须补发一次 resume，
	// 否则该设备永远停在暂停态，前端只能靠缩略图快照（约 10s 一张）看到画面。
	GlobalHub.mu.RLock()
	hasControlSub := false
	for c := range GlobalHub.Subscribers[deviceID] {
		if GlobalHub.SubscriberKind[deviceID][c] != "files" {
			hasControlSub = true
			break
		}
	}
	GlobalHub.mu.RUnlock()
	if hasControlSub {
		agent.SendControl(websocket.TextMessage, []byte(`{"action":"resume"}`))
		log.Printf("[Hub] Agent %s re-registered with viewers attached, resent resume", deviceID)
	}

	// 收到 Ping 时：重置读取超时，并通过单 writer 协程回复 Pong。
	// 不能在这里直接 conn.WriteMessage——会与 AgentWriter 并发写同一连接（gorilla 不支持），
	// 间歇性导致 Pong 丢失，Agent 每 80s 超时重连。
	conn.SetPingHandler(func(appData string) error {
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		select {
		case agent.controlQ <- controlMsg{MsgType: websocket.PongMessage, Payload: []byte(appData)}:
		case <-time.After(time.Second):
		case <-agent.closeQ:
		}
		return nil
	})

	FindOrRegisterDevice(deviceID, DeviceInfo{
		ID:   deviceID,
		Name: deviceName,
		OS:   deviceOS,
		IP:   deviceIP,
		CPU:  deviceCPU,
		RAM:  deviceRAM,
		MAC:  deviceMac,
	})

	defer func() {
		// 只有当前连接仍是该设备的活跃 Agent 时才清理并标离线；
		// 若已被新连接替换，旧 handler 退出不得影响新会话
		isCurrent := false
		GlobalHub.mu.Lock()
		if cur, ok := GlobalHub.Agents[deviceID]; ok && cur == agent {
			delete(GlobalHub.Agents, deviceID)
			isCurrent = true
		}
		GlobalHub.mu.Unlock()
		if isCurrent {
			MarkDeviceOffline(deviceID)
		}
		agent.Close()
	}()

	for {
		messageType, payload, err := conn.ReadMessage()
		if err != nil {
			break
		}
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))

		if messageType == websocket.BinaryMessage {
			if len(payload) > 14 && (payload[0] == 0x02 || payload[0] == 0x03 || payload[0] == 0x04) {
				GlobalHub.mu.Lock()
				// 保存完整帧（含 14 字节头），供新订阅者连接时直接推送
				frame := make([]byte, len(payload))
				copy(frame, payload)
				GlobalHub.LatestFrame[deviceID] = frame
				// 记录接收时间与帧序号，供缩略图判断过期与识别"新帧"
				GlobalHub.LatestFrameTime[deviceID] = time.Now()
				GlobalHub.LatestFrameSeq[deviceID]++
				GlobalHub.mu.Unlock()
				// 通过缓冲通道异步转发，防止慢订阅者阻塞 Agent 读取循环
				GlobalHub.mu.RLock()
				subs := GlobalHub.Subscribers[deviceID]
				channels := GlobalHub.SubscriberChannels[deviceID]
				kinds := GlobalHub.SubscriberKind[deviceID]
				for subConn := range subs {
					// 文件传输订阅者不需要画面帧，避免无谓的带宽与前端解码开销
					if kinds[subConn] == "files" {
						continue
					}
					if ch, ok := channels[subConn]; ok {
						select {
						case ch <- FrameMsg{MsgType: websocket.BinaryMessage, Payload: payload}:
							// 正常发送
						default:
							// 通道满：drain 掉最旧的帧，然后推送最新的
							select {
							case <-ch:
							default:
							}
							select {
							case ch <- FrameMsg{MsgType: websocket.BinaryMessage, Payload: payload}:
							default:
							}
						}
					}
				}
				GlobalHub.mu.RUnlock()
			} else {
				// 非视频二进制消息（如下载分块 0x01 等）通过缓冲通道转发，避免并发写 WS
				GlobalHub.mu.RLock()
				subs := GlobalHub.Subscribers[deviceID]
				channels := GlobalHub.SubscriberChannels[deviceID]
				for subConn := range subs {
					if ch, ok := channels[subConn]; ok {
						select {
						case ch <- FrameMsg{MsgType: websocket.BinaryMessage, Payload: payload}:
						default:
							// 通道满，丢弃旧消息，推最新的
							select {
							case <-ch:
							default:
							}
							select {
							case ch <- FrameMsg{MsgType: websocket.BinaryMessage, Payload: payload}:
							default:
							}
						}
					}
				}
				GlobalHub.mu.RUnlock()
			}
		} else if messageType == websocket.TextMessage {
			// 终端消息（terminal_opened/output/closed，JSON 含 "terminal_ 字段）广播给该设备的终端订阅者；
			// 其余文本消息维持原逻辑广播给视频订阅者
			if bytes.Contains(payload, []byte("\"terminal_")) {
				log.Printf("[Terminal] Agent %s sent terminal message: %s", deviceID, string(payload))
				BroadcastTerminal(deviceID, payload)
			} else if bytes.Contains(payload, []byte("get_ip_config")) ||
				bytes.Contains(payload, []byte("rename_computer")) ||
				bytes.Contains(payload, []byte("set_ip")) ||
				bytes.Contains(payload, []byte("check_ip_usage")) ||
				bytes.Contains(payload, []byte("ping_system")) ||
				bytes.Contains(payload, []byte("shutdown")) {
				// 系统配置响应（get_ip_config / rename_computer / set_ip）直接发送给 ResponseCh，
				// 不广播给订阅者
				select {
				case agent.ResponseCh <- payload:
				default:
					log.Printf("[Hub] Agent %s system-config response channel full, dropping response", deviceID)
				}
			} else {
				displayLen := len(payload)
				if displayLen > 200 {
					displayLen = 200
				}
				log.Printf("[Hub] Agent %s sent text: %s", deviceID, string(payload[:displayLen]))
				GlobalHub.mu.RLock()
				subs := GlobalHub.Subscribers[deviceID]
				channels := GlobalHub.SubscriberChannels[deviceID]
				log.Printf("[Hub] Forwarding text to %d subscribers", len(subs))
				for subConn := range subs {
					if ch, ok := channels[subConn]; ok {
						select {
						case ch <- FrameMsg{MsgType: websocket.TextMessage, Payload: payload}:
						default:
						}
					}
				}
				GlobalHub.mu.RUnlock()
			}
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
	if !validateDeviceID(deviceID) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"invalid device_id"}`))
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
		// 通过单 writer 协程投递（非并发安全写），1s 超时自动丢弃不阻塞 HTTP
		agentConn.SendControl(websocket.TextMessage, bytes)
	}
}

func handleListDevices(w http.ResponseWriter, r *http.Request) {
	list := GetKnownDeviceList()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(list)
}

// 设备缩略图：若缓存帧缺失或过期（>6s），向 Agent 发送 {"action":"snapshot"} 控制指令，
// 并短暂等待新帧（最多 2s）后返回，保证设备卡片无需先远程连接即可在轮询周期内拿到新鲜缩略图
func handleThumbnail(w http.ResponseWriter, r *http.Request) {
	deviceID := r.URL.Query().Get("device_id")
	if deviceID == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	// 锁内读取缓存帧、接收时间、帧序号与最近一次快照触发时间
	GlobalHub.mu.RLock()
	frame, exists := GlobalHub.LatestFrame[deviceID]
	frameTime, hasFrameTime := GlobalHub.LatestFrameTime[deviceID]
	seq := GlobalHub.LatestFrameSeq[deviceID]
	lastReq, hasReq := GlobalHub.LastSnapshotReq[deviceID]
	GlobalHub.mu.RUnlock()

	// 帧缺失或接收时间超过 6s 视为过期（Agent 空闲时已停推，需要主动触发快照）
	stale := !exists || len(frame) < 15 || !hasFrameTime || time.Since(frameTime) > 6*time.Second

	// 快照触发前的帧序号：等待循环以此判断是否出现了新帧
	seqBefore := seq
	triggered := false
	if stale {
		// 限流：距上次快照触发不足 3s 不再重复触发，避免轮询高频时刷爆 Agent
		if !hasReq || time.Since(lastReq) > 3*time.Second {
			triggered = true
			GlobalHub.mu.Lock()
			seqBefore = GlobalHub.LatestFrameSeq[deviceID]
			GlobalHub.mu.Unlock()

			GlobalHub.mu.RLock()
			agentConn, agentExists := GlobalHub.Agents[deviceID]
			GlobalHub.mu.RUnlock()

			if agentExists {
				log.Printf("[Hub] Thumbnail stale for device %s, requesting snapshot", deviceID)
				agentConn.SendControl(websocket.TextMessage, []byte(`{"action":"snapshot"}`))
			}

			GlobalHub.mu.Lock()
			GlobalHub.LastSnapshotReq[deviceID] = time.Now()
			GlobalHub.mu.Unlock()
		}

		// 仅本次实际触发了快照时才等待新帧；未触发（限流）则直接用当前帧返回
		if triggered {
			// 等待新帧：最多 2s，每 100ms 检查一次；帧序号大于触发前序号视为新帧，超时则用最后读到的帧继续
			deadline := time.Now().Add(2 * time.Second)
			for time.Now().Before(deadline) {
				time.Sleep(100 * time.Millisecond)
				GlobalHub.mu.RLock()
				curFrame, curExists := GlobalHub.LatestFrame[deviceID]
				curSeq := GlobalHub.LatestFrameSeq[deviceID]
				GlobalHub.mu.RUnlock()
				frame = curFrame
				exists = curExists
				if curExists && len(curFrame) >= 15 && curSeq > seqBefore {
					break
				}
			}
		}
	}

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
	conn.SetReadLimit(10 * 1024 * 1024) // 10MB 读取限制，允许大文件分块传输
	// 保活策略：Hub 每 20s 主动发 Ping，浏览器自动回 Pong；收到 Pong 重置读超时。
	// 订阅者平时只发控制指令，空闲 60s 是常态，旧的"固定 60s 读超时"会把观看中的前端强制踢下线。
	conn.SetReadDeadline(time.Now().Add(75 * time.Second))
	conn.SetPongHandler(func(appData string) error {
		conn.SetReadDeadline(time.Now().Add(75 * time.Second))
		return nil
	})

	// TCP_NODELAY: 降低网络延迟
	if tcp, ok := conn.UnderlyingConn().(*net.TCPConn); ok {
		tcp.SetNoDelay(true)
	}

	deviceID := r.URL.Query().Get("device_id")
	kind := r.URL.Query().Get("kind")
	if kind != "files" {
		kind = "control"
	}

	// 创建缓冲通道（容量4），足够吸收瞬发爆发帧，满了就 drain 旧帧保持最新
	ch := make(chan FrameMsg, 4)
	done := make(chan struct{})

	GlobalHub.mu.Lock()
	// 只有 control 订阅者才算"有人在看画面"：文件通道连接不应触发 Agent 恢复截图
	wasEmpty := false
	if kind == "control" {
		wasEmpty = true
		for c := range GlobalHub.Subscribers[deviceID] {
			if GlobalHub.SubscriberKind[deviceID][c] != "files" {
				wasEmpty = false
				break
			}
		}
	}
	if GlobalHub.Subscribers[deviceID] == nil {
		GlobalHub.Subscribers[deviceID] = make(map[*websocket.Conn]bool)
	}
	GlobalHub.Subscribers[deviceID][conn] = true

	if GlobalHub.SubscriberChannels[deviceID] == nil {
		GlobalHub.SubscriberChannels[deviceID] = make(map[*websocket.Conn]chan FrameMsg)
	}
	GlobalHub.SubscriberChannels[deviceID][conn] = ch

	if GlobalHub.SubscriberKind[deviceID] == nil {
		GlobalHub.SubscriberKind[deviceID] = make(map[*websocket.Conn]string)
	}
	GlobalHub.SubscriberKind[deviceID][conn] = kind
	GlobalHub.mu.Unlock()

	// 单 writer goroutine：串行写视频帧 + 每 20s 发 Ping（gorilla/websocket 不允许并发写，
	// 保活 Ping 必须与帧写入共用同一 goroutine，否则帧交错损坏）
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Println("[Hub] Recovered in subscriber writer:", r)
			}
		}()
		pingTicker := time.NewTicker(20 * time.Second)
		defer pingTicker.Stop()
		for {
			select {
			case msg, ok := <-ch:
				if !ok {
					return
				}
				_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := conn.WriteMessage(msg.MsgType, msg.Payload); err != nil {
					return
				}
			case <-pingTicker.C:
				_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					return
				}
			case <-done:
				return
			}
		}
	}()

	// 第一个订阅者连接时通知 Agent 恢复截图
	if wasEmpty {
		GlobalHub.mu.RLock()
		agentConn, exists := GlobalHub.Agents[deviceID]
		GlobalHub.mu.RUnlock()
		if exists {
			agentConn.SendControl(websocket.TextMessage, []byte(`{"action":"resume"}`))
		}
	}

	// 订阅时立即推送最新缓存帧，确保被控端画面静止时控制窗口也能显示画面。
	// 必须走订阅通道：conn 只允许 writer goroutine 写，直接 WriteMessage 会与帧写入并发。
	if kind == "control" {
		GlobalHub.mu.RLock()
		latestFrame := GlobalHub.LatestFrame[deviceID]
		GlobalHub.mu.RUnlock()
		if latestFrame != nil {
			select {
			case ch <- FrameMsg{MsgType: websocket.BinaryMessage, Payload: latestFrame}:
			default:
			}
		}
	}

	defer func() {
		var becameEmpty bool
		GlobalHub.mu.Lock()
		if GlobalHub.Subscribers[deviceID] != nil {
			delete(GlobalHub.Subscribers[deviceID], conn)
			if kindMap := GlobalHub.SubscriberKind[deviceID]; kindMap != nil {
				delete(kindMap, conn)
				if len(kindMap) == 0 {
					delete(GlobalHub.SubscriberKind, deviceID)
				}
			}
			hasControl := false
			for c := range GlobalHub.Subscribers[deviceID] {
				if GlobalHub.SubscriberKind[deviceID][c] != "files" {
					hasControl = true
					break
				}
			}
			if len(GlobalHub.Subscribers[deviceID]) == 0 {
				delete(GlobalHub.Subscribers, deviceID)
			}
			becameEmpty = kind == "control" && !hasControl
		}
		// 清理通道并关闭
		if ch, ok := GlobalHub.SubscriberChannels[deviceID][conn]; ok {
			close(ch)
			delete(GlobalHub.SubscriberChannels[deviceID], conn)
			if len(GlobalHub.SubscriberChannels[deviceID]) == 0 {
				delete(GlobalHub.SubscriberChannels, deviceID)
			}
		}
		GlobalHub.mu.Unlock()
		close(done) // 停止保活 Ping goroutine
		conn.Close()

		// 最后一个订阅者离开时通知 Agent 暂停截图
		if becameEmpty {
			GlobalHub.mu.RLock()
			agentConn, exists := GlobalHub.Agents[deviceID]
			GlobalHub.mu.RUnlock()
			if exists {
				agentConn.SendControl(websocket.TextMessage, []byte(`{"action":"pause"}`))
			}
		}
	}()

	// 挂起连接持续等待监听退订事件和控制指令
	for {
		messageType, payload, err := conn.ReadMessage()
		if err != nil {
			break
		}
		conn.SetReadDeadline(time.Now().Add(75 * time.Second))

		// 将客户端发来的 WebSocket 文本消息（控制指令）透传给 Agent，降低控制延迟
		if messageType == websocket.TextMessage || messageType == websocket.BinaryMessage {
			if messageType == websocket.TextMessage {
				displayLen := len(payload)
				if displayLen > 200 {
					displayLen = 200
				}
				log.Printf("[Hub] Subscriber for %s sent text: %s", deviceID, string(payload[:displayLen]))
			} else {
				log.Printf("[Hub] Subscriber for %s sent binary (%d bytes, type=0x%02X)", deviceID, len(payload), payload[0])
			}
			GlobalHub.mu.RLock()
			agentConn, exists := GlobalHub.Agents[deviceID]
			GlobalHub.mu.RUnlock()
			if exists {
				if messageType == websocket.BinaryMessage {
					select {
					case agentConn.payloadQ <- FrameMsg{MsgType: messageType, Payload: payload}:
					case <-time.After(500 * time.Millisecond):
						log.Printf("[Hub] Agent %s payload queue full, drop %d bytes", deviceID, len(payload))
					case <-agentConn.closeQ:
					}
				} else {
					agentConn.SendControl(messageType, payload)
				}
			} else {
				log.Printf("[Hub] Agent %s not found, cannot forward message", deviceID)
			}
		}
	}
}

// 浏览器前端远程终端（控制台）接入：前端 → Hub → Agent 双向中转终端指令与输出。
// 前端通过 WS 发送 terminal_open/terminal_input/terminal_resize/terminal_close 等 JSON 指令，
// Hub 原样透传给目标 Agent；Agent 回传的 terminal_opened/output/closed 由 BroadcastTerminal 广播给本设备全部终端订阅者。
func handleTerminalSubscribe(w http.ResponseWriter, r *http.Request) {
	deviceID := r.URL.Query().Get("device_id")
	if !validateDeviceID(deviceID) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"invalid device_id"}`))
		return
	}

	// 目标 Agent 必须在线，否则不升级 WS，直接返回 502
	GlobalHub.mu.RLock()
	agentConn, exists := GlobalHub.Agents[deviceID]
	GlobalHub.mu.RUnlock()
	if !exists {
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte(`{"error":"device not online"}`))
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("[Terminal] Upgrade error:", err)
		return
	}
	conn.SetReadLimit(10 * 1024 * 1024) // 10MB 读取限制
	conn.SetReadDeadline(time.Now().Add(75 * time.Second))
	conn.SetPongHandler(func(appData string) error {
		conn.SetReadDeadline(time.Now().Add(75 * time.Second))
		return nil
	})

	// TCP_NODELAY: 降低网络延迟
	if tcp, ok := conn.UnderlyingConn().(*net.TCPConn); ok {
		tcp.SetNoDelay(true)
	}

	// 缓冲通道（容量64），吸收瞬时终端输出，满了丢弃旧消息保持最新
	ch := make(chan []byte, 64)
	done := make(chan struct{})

	RegisterTerminalSubscriber(deviceID, conn, ch)

	// 单 writer goroutine：串行写终端消息 + 每 20s 发 Ping 保活（gorilla/websocket 不允许并发写，
	// 保活 Ping 必须与消息写入共用同一 goroutine）。浏览器原生 WebSocket 不主动发 ping，
	// 若不加保活，前端在行缓冲模式下打字不产生 WS 流量，75s 读超时后连接被静默踢下线。
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				log.Println("[Terminal] Recovered in terminal writer:", rec)
			}
		}()
		pingTicker := time.NewTicker(20 * time.Second)
		defer pingTicker.Stop()
		for {
			select {
			case data, ok := <-ch:
				if !ok {
					return
				}
				_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
					log.Printf("[Terminal] write to subscriber for %s failed: %v, exiting writer", deviceID, err)
					return
				}
			case <-pingTicker.C:
				_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					return
				}
			case <-done:
				return
			}
		}
	}()

	defer func() {
		UnregisterTerminalSubscriber(deviceID, conn)
		close(done) // 停止 writer goroutine
		conn.Close()
	}()

	// 读循环：前端终端指令原样透传给 Agent（不解析内容）
	for {
		messageType, payload, err := conn.ReadMessage()
		if err != nil {
			break
		}
		conn.SetReadDeadline(time.Now().Add(75 * time.Second))
		if messageType == websocket.TextMessage {
			agentConn.SendControl(websocket.TextMessage, payload)
		}
	}
}

var exeConfigGUID = []byte{0xB9, 0x96, 0x01, 0x58, 0x80, 0x54, 0x4A, 0x19, 0xB7, 0xF7, 0xE9, 0xBE, 0x44, 0x91, 0x4C, 0x18}

func GetLocalIP() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		log.Println("[getLocalIP] Failed to get interfaces:", err)
		return "127.0.0.1"
	}

	// 按优先级收集：先找局域网 IP（192.168/10.x），排除 Docker 虚拟 IP
	var fallback string
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
			if ip == nil || ip.To4() == nil {
				continue
			}
			ip = ip.To4() // 转为 4 字节 IPv4，否则 ip[0]/ip[1] 读的是 16 字节映射格式
			s := ip.String()
			// 跳过 Docker 虚拟 IP（172.17-31.x.x）
			if ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31 {
				log.Printf("[getLocalIP] skipping Docker IP: %s (iface: %s)", s, iface.Name)
				continue
			}
			// 跳过 169.254.x.x（链路本地）
			if ip[0] == 169 && ip[1] == 254 {
				log.Printf("[getLocalIP] skipping link-local IP: %s (iface: %s)", s, iface.Name)
				continue
			}
			// 优先返回 192.168.x.x
			if ip[0] == 192 && ip[1] == 168 {
				log.Printf("[getLocalIP] selected LAN IP: %s (iface: %s)", s, iface.Name)
				return s
			}
			// 其次 10.x.x.x
			if ip[0] == 10 {
				log.Printf("[getLocalIP] selected LAN IP: %s (iface: %s)", s, iface.Name)
				return s
			}
			// 其他非虚拟 IP 作为备选
			if fallback == "" {
				log.Printf("[getLocalIP] fallback IP: %s (iface: %s)", s, iface.Name)
				fallback = s
			}
		}
	}
	if fallback != "" {
		log.Printf("[getLocalIP] using fallback IP: %s", fallback)
		return fallback
	}
	log.Println("[getLocalIP] no suitable IP found, returning 127.0.0.1")
	return "127.0.0.1"
}

func handleAgentDownload(w http.ResponseWriter, r *http.Request) {
	if len(AgentDownloadData) == 0 {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte("Agent exe not found"))
		return
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
		host = GetLocalIP()
	}
	host = net.JoinHostPort(host, port)

	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	configJSON, _ := json.Marshal(map[string]string{"server_url": scheme + "://" + host})

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename=\"exhibition-agent.exe\"")
	w.Write(AgentDownloadData)
	w.Write(configJSON)
	binary.Write(w, binary.BigEndian, uint32(len(configJSON)))
	w.Write(exeConfigGUID)
}

func handleDiscoveredDevices(w http.ResponseWriter, r *http.Request) {
	list := GetDiscoveredDevices()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(list)
}

func handleAddDevice(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		w.Write([]byte(`{"error":"method not allowed"}`))
		return
	}
	var req struct {
		ID string `json:"device_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !validateDeviceID(req.ID) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"invalid request"}`))
		return
	}
	if AddDeviceToKnown(req.ID) {
		w.Write([]byte(`{"status":"ok"}`))
	} else {
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"error":"device already exists"}`))
	}
}

func handleRemoveDevice(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		w.Write([]byte(`{"error":"method not allowed"}`))
		return
	}
	var req struct {
		ID string `json:"device_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !validateDeviceID(req.ID) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"invalid request"}`))
		return
	}
	if RemoveDeviceFromKnown(req.ID) {
		w.Write([]byte(`{"status":"ok"}`))
	} else {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":"device not found"}`))
	}
}

func handleRenameDevice(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		w.Write([]byte(`{"error":"method not allowed"}`))
		return
	}
	var req struct {
		ID   string `json:"device_id"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !validateDeviceID(req.ID) || req.Name == "" {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"invalid request"}`))
		return
	}
	if RenameDevice(req.ID, req.Name) {
		w.Write([]byte(`{"status":"ok"}`))
	} else {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":"device not found"}`))
	}
}

func handleReorderDevices(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		w.Write([]byte(`{"error":"method not allowed"}`))
		return
	}
	var req struct {
		Order []string `json:"order"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.Order) == 0 {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"invalid request"}`))
		return
	}
	if ReorderDevices(req.Order) {
		w.Write([]byte(`{"status":"ok"}`))
	} else {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"reorder failed"}`))
	}
}

func handleUpdateTags(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		w.Write([]byte(`{"error":"method not allowed"}`))
		return
	}
	var req struct {
		ID   string   `json:"device_id"`
		Tags []string `json:"tags"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID == "" {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"invalid request"}`))
		return
	}
	if UpdateDeviceTags(req.ID, req.Tags) {
		w.Write([]byte(`{"status":"ok"}`))
	} else {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":"device not found"}`))
	}
}

// handleSystemConfig 处理远程系统配置请求（get_ip_config / rename_computer / set_ip）。
// 请求通过 WebSocket 发送给 Agent，同步等待响应（5s 超时），返回操作结果。
func handleSystemConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "method not allowed"})
		return
	}

	var req struct {
		DeviceID  string   `json:"device_id"`
		Action    string   `json:"action"`
		Name      string   `json:"name,omitempty"`
		Interface string   `json:"interface,omitempty"`
		IP        string   `json:"ip,omitempty"`
		Mask      string   `json:"mask,omitempty"`
		Gateway   string   `json:"gateway,omitempty"`
		DNS       []string `json:"dns,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "invalid json"})
		return
	}
	if !validateDeviceID(req.DeviceID) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "invalid device_id"})
		return
	}

	// 验证 action
	switch req.Action {
	case "get_ip_config", "rename_computer", "set_ip", "check_ip_usage", "ping_system", "shutdown":
		// valid
	default:
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "invalid action, must be one of: get_ip_config, rename_computer, set_ip"})
		return
	}

	// 检查 Agent 是否在线
	GlobalHub.mu.RLock()
	agent, exists := GlobalHub.Agents[req.DeviceID]
	GlobalHub.mu.RUnlock()
	if !exists {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "device not online"})
		return
	}

	// 构建 command JSON
	cmd := map[string]interface{}{
		"action":    req.Action,
		"device_id": req.DeviceID,
	}
	switch req.Action {
	case "rename_computer":
		if req.Name == "" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "name is required for rename_computer"})
			return
		}
		cmd["name"] = req.Name
	case "set_ip":
		if req.Interface == "" || req.IP == "" || req.Mask == "" || req.Gateway == "" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "interface, ip, mask, gateway are required for set_ip"})
			return
		}
		cmd["interface"] = req.Interface
		cmd["ip"] = req.IP
		cmd["mask"] = req.Mask
		cmd["gateway"] = req.Gateway
		if len(req.DNS) > 0 {
			cmd["dns"] = req.DNS
		}
	}

	cmdBytes, err := json.Marshal(cmd)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "failed to marshal command"})
		return
	}

	// 通过控制通道发送给 Agent
	if !agent.SendControl(websocket.TextMessage, cmdBytes) {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "failed to send command to agent"})
		return
	}

	// 同步等待 Agent 响应（15s 超时，PowerShell 命令可能需要较长时间）
	select {
	case respBytes, ok := <-agent.ResponseCh:
		if !ok {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "response channel closed"})
			return
		}
		var resp map[string]interface{}
		if err := json.Unmarshal(respBytes, &resp); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "invalid response from agent"})
			return
		}
		// 透传 Agent 的响应
		success, _ := resp["success"].(bool)
		if !success {
			errMsg, _ := resp["error"].(string)
			if errMsg == "" {
				errMsg = "agent returned failure"
			}
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": errMsg})
			return
		}
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(resp)
	case <-time.After(15 * time.Second):
		w.WriteHeader(http.StatusGatewayTimeout)
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "agent response timeout"})
	}
}
