package hub

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type DeviceInfo struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	OS     string   `json:"os"`
	IP     string   `json:"ip"`
	CPU    string   `json:"cpu"`
	RAM    string   `json:"ram"`
	MAC    string   `json:"mac"`
	Online bool     `json:"online"`
	Order  int      `json:"order"`
	Tags   []string `json:"tags"`
	Added  bool     `json:"added"`
}

type KnownDevice struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Order   int      `json:"order"`
	Tags    []string `json:"tags"`
	AddedAt string   `json:"added_at"`
	MAC     string   `json:"mac,omitempty"` // Agent 注册时带回，持久化供 WOL 远程开机使用
}

type DeviceStorage struct {
	KnownDevices      []KnownDevice   `json:"known_devices"`
	DiscoveredDevices map[string]bool `json:"discovered_devices"` // device IDs that connected but not yet added
}

type FrameMsg struct {
	MsgType int
	Payload []byte
}

// AgentConn 包装 Rust Agent 的 WS 连接，确保"单 writer 协程"串行写入。
// gorilla/websocket 的 *Conn.WriteMessage 不是并发安全的，并发写会导致帧交错崩溃。
type AgentConn struct {
	Conn       *websocket.Conn
	controlQ   chan controlMsg // 高优先级：控制指令（外部 HTTP control API + pause/resume 心跳等）
	payloadQ   chan FrameMsg   // 低优先级：给 Agent 发送的文件/数据（预留，目前主要是 controlQ）
	ResponseCh chan []byte     // 系统配置响应通道（如 get_ip_config / rename_computer / set_ip 的返回结果）
	closeQ     chan struct{}   // 关闭信号，writer goroutine 退出
	deviceID   string          // 仅日志用
}

type controlMsg struct {
	MsgType int
	Payload []byte
}

// StartWriter 启动该 Agent 的"单 writer 协程"，串行 drain controlQ/payloadQ。
// 任何要写到 Agent 连接的数据必须提交到 chan，不能直接 Conn.WriteMessage。
func (a *AgentConn) StartWriter() {
	go func() {
		defer func() {
			_ = recover()
			_ = a.Conn.Close()
		}()
		for {
			select {
			case <-a.closeQ:
				return
			case msg, ok := <-a.controlQ:
				if !ok {
					return
				}
				// 单次写超时 2s（Agent TCP 窗口堵死时避免整个 writer 卡死）
				_ = a.Conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
				if err := a.Conn.WriteMessage(msg.MsgType, msg.Payload); err != nil {
					log.Printf("[AgentWriter] %s control write failed: %v, exiting writer", a.deviceID, err)
					return
				}
			case msg, ok := <-a.payloadQ:
				if !ok {
					return
				}
				_ = a.Conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
				if err := a.Conn.WriteMessage(msg.MsgType, msg.Payload); err != nil {
					log.Printf("[AgentWriter] %s payload write failed: %v, exiting writer", a.deviceID, err)
					return
				}
			}
		}
	}()
}

// Close 关闭 writer 协程并关闭底层连接，幂等。
func (a *AgentConn) Close() {
	select {
	case <-a.closeQ:
		// 已关
	default:
		close(a.closeQ)
	}
	_ = a.Conn.Close()
}

// SendControl 提交一条控制指令给 writer，超时 1s。成功返回 true，失败（writer死/队列满）返回 false。
func (a *AgentConn) SendControl(msgType int, payload []byte) bool {
	select {
	case a.controlQ <- controlMsg{MsgType: msgType, Payload: payload}:
		return true
	case <-time.After(time.Second):
		log.Printf("[AgentWriter] %s control queue full (>%d) or writer dead, drop msg len=%d",
			a.deviceID, cap(a.controlQ), len(payload))
		return false
	case <-a.closeQ:
		return false
	}
}

type DeviceHub struct {
	mu                  sync.RWMutex
	Agents              map[string]*AgentConn                        // Rust 被控端 WS 连接（含单 writer 协程）
	DeviceInfos         map[string]DeviceInfo                        // 存放设备信息
	LatestFrame         map[string][]byte                            // 存放最新一帧完整的画面作为缩略图
	LatestFrameTime     map[string]time.Time                         // 最近一帧接收时间，用于判断缩略图是否过期
	LatestFrameSeq      map[string]uint64                            // 帧序号，用于识别"新帧"（快照触发后等待新帧）
	LastSnapshotReq     map[string]time.Time                         // 最近一次快照触发时间，用于限流
	Subscribers         map[string]map[*websocket.Conn]bool          // 存放订阅特定设备画面流的第三方应用连接
	SubscriberChannels  map[string]map[*websocket.Conn]chan FrameMsg // 订阅者缓冲通道，帧满时 drain 旧帧
	SubscriberKind      map[string]map[*websocket.Conn]string        // 订阅用途：control（画面/控制）或 files（仅文件传输）
	TerminalSubscribers map[string]map[*websocket.Conn]chan []byte   // 终端(控制台)订阅者：device_id → 终端订阅者集合
	DeviceStorage       *DeviceStorage                               // 持久化设备存储
}

var GlobalHub = &DeviceHub{
	Agents:              make(map[string]*AgentConn),
	DeviceInfos:         make(map[string]DeviceInfo),
	LatestFrame:         make(map[string][]byte),
	LatestFrameTime:     make(map[string]time.Time),
	LatestFrameSeq:      make(map[string]uint64),
	LastSnapshotReq:     make(map[string]time.Time),
	Subscribers:         make(map[string]map[*websocket.Conn]bool),
	SubscriberChannels:  make(map[string]map[*websocket.Conn]chan FrameMsg),
	SubscriberKind:      make(map[string]map[*websocket.Conn]string),
	TerminalSubscribers: make(map[string]map[*websocket.Conn]chan []byte),
	// DeviceStorage is set in InitRouter
}

func dataDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
	}
	dir := filepath.Join(base, "ExhibitionHub", "data")
	os.MkdirAll(dir, 0755)
	return dir
}

func storagePath() string {
	return filepath.Join(dataDir(), "device_storage.json")
}

func loadDeviceStorage() *DeviceStorage {
	ds := &DeviceStorage{
		KnownDevices:      []KnownDevice{},
		DiscoveredDevices: make(map[string]bool),
	}
	data, err := os.ReadFile(storagePath())
	if err != nil {
		if os.IsNotExist(err) {
			return ds
		}
		log.Printf("[Hub] Error reading device storage: %v", err)
		return ds
	}
	if err := json.Unmarshal(data, ds); err != nil {
		log.Printf("[Hub] Error parsing device storage: %v", err)
	}
	return ds
}

var storageWriteMu sync.Mutex

func saveDeviceStorage() {
	GlobalHub.mu.RLock()
	knownDevices := make([]KnownDevice, len(GlobalHub.DeviceStorage.KnownDevices))
	copy(knownDevices, GlobalHub.DeviceStorage.KnownDevices)
	discoveredCopy := make(map[string]bool)
	for k, v := range GlobalHub.DeviceStorage.DiscoveredDevices {
		discoveredCopy[k] = v
	}
	GlobalHub.mu.RUnlock()

	ds := &DeviceStorage{
		KnownDevices:      knownDevices,
		DiscoveredDevices: discoveredCopy,
	}
	data, err := json.MarshalIndent(ds, "", "  ")
	if err != nil {
		log.Printf("[Hub] Error marshaling device storage: %v", err)
		return
	}

	// 串行化写入 + 临时文件 rename，避免并发写互相覆盖或断电留下半截 JSON
	storageWriteMu.Lock()
	defer storageWriteMu.Unlock()
	path := storagePath()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		log.Printf("[Hub] Error writing device storage: %v", err)
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		log.Printf("[Hub] Error replacing device storage: %v", err)
	}
}

// restorePersistedDevices 启动时将持久化的设备元数据恢复到内存设备列表：
// - 已添加(known)设备恢复为离线占位设备（保留自定义名称/排序/标签），
//   否则 Hub 重启后离线未重连的已添加设备会从设备列表中消失；
// - 已发现(discovered)设备恢复为离线待添加设备，等待 Agent 重新连接补充详情。
func restorePersistedDevices() {
	GlobalHub.mu.Lock()
	defer GlobalHub.mu.Unlock()

	for _, kd := range GlobalHub.DeviceStorage.KnownDevices {
		if _, exists := GlobalHub.DeviceInfos[kd.ID]; exists {
			continue
		}
		GlobalHub.DeviceInfos[kd.ID] = DeviceInfo{
			ID:     kd.ID,
			Name:   kd.Name,
			Online: false,
			Order:  kd.Order,
			Tags:   kd.Tags,
			Added:  true,
			MAC:    kd.MAC, // 恢复持久化的 MAC，离线设备也保留远程开机(WOL)能力
		}
	}

	for id := range GlobalHub.DeviceStorage.DiscoveredDevices {
		if _, exists := GlobalHub.DeviceInfos[id]; exists {
			continue
		}
		GlobalHub.DeviceInfos[id] = DeviceInfo{
			ID:     id,
			Name:   id,
			Online: false,
			Added:  false,
		}
	}
}

// GetKnownDevice returns the KnownDevice entry for a given ID, or nil
func GetKnownDevice(id string) *KnownDevice {
	for i := range GlobalHub.DeviceStorage.KnownDevices {
		if GlobalHub.DeviceStorage.KnownDevices[i].ID == id {
			return &GlobalHub.DeviceStorage.KnownDevices[i]
		}
	}
	return nil
}

// IsDiscovered checks if a device ID is in the discovered list
func IsDiscovered(id string) bool {
	return GlobalHub.DeviceStorage.DiscoveredDevices[id]
}

// FindOrRegisterDevice checks if a device is known, or registers as discovered
func FindOrRegisterDevice(id string, info DeviceInfo) {
	GlobalHub.mu.Lock()
	defer GlobalHub.mu.Unlock()

	known := GetKnownDevice(id)
	if known != nil {
		// Device is already known, just update online status (keep custom name from KnownDevice)
		existing, exists := GlobalHub.DeviceInfos[id]
		if exists {
			existing.OS = info.OS
			existing.IP = info.IP
			existing.CPU = info.CPU
			existing.RAM = info.RAM
			existing.MAC = info.MAC
			existing.Online = true
			existing.Name = known.Name
			existing.Tags = known.Tags
			existing.Order = known.Order
			GlobalHub.DeviceInfos[id] = existing
		} else {
			info.Online = true
			info.Added = true
			info.Order = known.Order
			info.Tags = known.Tags
			info.Name = known.Name
			GlobalHub.DeviceInfos[id] = info
		}
		// 持久化 MAC（首次/补录）：Agent 在线时若 known 记录缺 MAC 或 MAC 变化，同步写入存储，
		// 保证离线后仍有 MAC 可用于 WOL 远程开机
		if info.MAC != "" && known.MAC != info.MAC {
			known.MAC = info.MAC
			go saveDeviceStorage()
		}
		return
	}

	// Device not known yet — auto-add to known devices so it appears immediately in the device list.
	// Agents connect to /agent/register intentionally (WebSocket), they should not be "discovered".
	maxOrder := 0
	for _, d := range GlobalHub.DeviceStorage.KnownDevices {
		if d.Order > maxOrder {
			maxOrder = d.Order
		}
	}
	GlobalHub.DeviceStorage.KnownDevices = append(GlobalHub.DeviceStorage.KnownDevices, KnownDevice{
		ID:      id,
		Name:    info.Name,
		Order:   maxOrder + 1,
		Tags:    []string{},
		AddedAt: time.Now().UTC().Format(time.RFC3339),
		MAC:     info.MAC, // 首次注册即持久化 MAC，供离线时 WOL 远程开机
	})
	info.Online = true
	info.Added = true
	info.Order = maxOrder + 1
	GlobalHub.DeviceInfos[id] = info
	go saveDeviceStorage()
}

// MarkDeviceOffline marks a device as offline
func MarkDeviceOffline(id string) {
	GlobalHub.mu.Lock()
	defer GlobalHub.mu.Unlock()

	if info, exists := GlobalHub.DeviceInfos[id]; exists {
		info.Online = false
		GlobalHub.DeviceInfos[id] = info
	}
}

// AddDeviceToKnown adds a discovered device to the known devices list
func AddDeviceToKnown(id string) bool {
	GlobalHub.mu.Lock()
	defer GlobalHub.mu.Unlock()

	if GetKnownDevice(id) != nil {
		return false // already known
	}

	maxOrder := 0
	for _, d := range GlobalHub.DeviceStorage.KnownDevices {
		if d.Order > maxOrder {
			maxOrder = d.Order
		}
	}

	GlobalHub.DeviceStorage.KnownDevices = append(GlobalHub.DeviceStorage.KnownDevices, KnownDevice{
		ID:      id,
		Name:    id, // default name = device ID
		Order:   maxOrder + 1,
		Tags:    []string{},
		AddedAt: time.Now().UTC().Format(time.RFC3339),
	})

	// Remove from discovered
	delete(GlobalHub.DeviceStorage.DiscoveredDevices, id)

	// Update DeviceInfos
	if info, exists := GlobalHub.DeviceInfos[id]; exists {
		info.Added = true
		info.Order = maxOrder + 1
		GlobalHub.DeviceInfos[id] = info
	}

	go saveDeviceStorage()
	return true
}

// RemoveDeviceFromKnown removes a device from the known list
func RemoveDeviceFromKnown(id string) bool {
	GlobalHub.mu.Lock()
	defer GlobalHub.mu.Unlock()

	idx := -1
	for i, d := range GlobalHub.DeviceStorage.KnownDevices {
		if d.ID == id {
			idx = i
			break
		}
	}
	if idx == -1 {
		return false
	}

	GlobalHub.DeviceStorage.KnownDevices = append(
		GlobalHub.DeviceStorage.KnownDevices[:idx],
		GlobalHub.DeviceStorage.KnownDevices[idx+1:]...,
	)

	// 从内存设备列表中彻底移除，避免残留为“离线待添加”的幽灵发现设备；
	// Agent 重新连接时 FindOrRegisterDevice 会将其重新发现
	delete(GlobalHub.DeviceInfos, id)

	go saveDeviceStorage()
	return true
}

// RenameDevice renames a known device
func RenameDevice(id, name string) bool {
	GlobalHub.mu.Lock()
	defer GlobalHub.mu.Unlock()

	known := GetKnownDevice(id)
	if known == nil {
		return false
	}
	known.Name = name

	if info, exists := GlobalHub.DeviceInfos[id]; exists {
		info.Name = name
		GlobalHub.DeviceInfos[id] = info
	}

	go saveDeviceStorage()
	return true
}

// ReorderDevices updates the order of known devices
func ReorderDevices(order []string) bool {
	GlobalHub.mu.Lock()
	defer GlobalHub.mu.Unlock()

	orderMap := make(map[string]int)
	for i, id := range order {
		orderMap[id] = i + 1
	}

	for i := range GlobalHub.DeviceStorage.KnownDevices {
		if newOrder, ok := orderMap[GlobalHub.DeviceStorage.KnownDevices[i].ID]; ok {
			GlobalHub.DeviceStorage.KnownDevices[i].Order = newOrder
		}
	}

	sort.Slice(GlobalHub.DeviceStorage.KnownDevices, func(a, b int) bool {
		return GlobalHub.DeviceStorage.KnownDevices[a].Order < GlobalHub.DeviceStorage.KnownDevices[b].Order
	})

	// Re-number sequentially
	for i := range GlobalHub.DeviceStorage.KnownDevices {
		GlobalHub.DeviceStorage.KnownDevices[i].Order = i + 1
		// Update DeviceInfos
		if info, exists := GlobalHub.DeviceInfos[GlobalHub.DeviceStorage.KnownDevices[i].ID]; exists {
			info.Order = i + 1
			GlobalHub.DeviceInfos[GlobalHub.DeviceStorage.KnownDevices[i].ID] = info
		}
	}

	go saveDeviceStorage()
	return true
}

// UpdateDeviceTags updates tags for a known device
func UpdateDeviceTags(id string, tags []string) bool {
	GlobalHub.mu.Lock()
	defer GlobalHub.mu.Unlock()

	known := GetKnownDevice(id)
	if known == nil {
		return false
	}
	known.Tags = tags

	if info, exists := GlobalHub.DeviceInfos[id]; exists {
		info.Tags = tags
		GlobalHub.DeviceInfos[id] = info
	}

	go saveDeviceStorage()
	return true
}

// GetAllDevices returns the full device list for the API
func GetAllDevices() []DeviceInfo {
	GlobalHub.mu.RLock()
	defer GlobalHub.mu.RUnlock()

	list := make([]DeviceInfo, 0, len(GlobalHub.DeviceInfos))
	for _, info := range GlobalHub.DeviceInfos {
		if info.Name == "" {
			info.Name = info.ID
		}
		// Fill in known device metadata
		if known := GetKnownDevice(info.ID); known != nil {
			info.Name = known.Name
			info.Order = known.Order
			info.Tags = known.Tags
			info.Added = true
		} else {
			info.Order = 0
			info.Added = false
			if info.Name == "" {
				info.Name = info.ID
			}
		}
		list = append(list, info)
	}

	// Sort by order for known devices, then by ID
	sort.Slice(list, func(a, b int) bool {
		if list[a].Added != list[b].Added {
			return list[a].Added && !list[b].Added
		}
		if list[a].Order != list[b].Order {
			return list[a].Order < list[b].Order
		}
		return list[a].ID < list[b].ID
	})

	return list
}

// GetDiscoveredDevices returns devices that have connected but are not added
func GetDiscoveredDevices() []DeviceInfo {
	all := GetAllDevices()
	result := make([]DeviceInfo, 0)
	for _, d := range all {
		if !d.Added {
			result = append(result, d)
		}
	}
	return result
}

// GetKnownDeviceList returns only added/known devices
func GetKnownDeviceList() []DeviceInfo {
	all := GetAllDevices()
	result := make([]DeviceInfo, 0)
	for _, d := range all {
		if d.Added {
			result = append(result, d)
		}
	}
	return result
}

// ── 终端(控制台)订阅者管理 ──

// RegisterTerminalSubscriber 注册某设备的终端订阅者（前端远程控制台连接）
func RegisterTerminalSubscriber(deviceID string, conn *websocket.Conn, ch chan []byte) {
	GlobalHub.mu.Lock()
	defer GlobalHub.mu.Unlock()

	if GlobalHub.TerminalSubscribers[deviceID] == nil {
		GlobalHub.TerminalSubscribers[deviceID] = make(map[*websocket.Conn]chan []byte)
	}
	GlobalHub.TerminalSubscribers[deviceID][conn] = ch
}

// UnregisterTerminalSubscriber 移除某设备的终端订阅者，订阅者为空时删除 map 键
func UnregisterTerminalSubscriber(deviceID string, conn *websocket.Conn) {
	GlobalHub.mu.Lock()
	defer GlobalHub.mu.Unlock()

	subs := GlobalHub.TerminalSubscribers[deviceID]
	if subs == nil {
		return
	}
	delete(subs, conn)
	if len(subs) == 0 {
		delete(GlobalHub.TerminalSubscribers, deviceID)
	}
}

// BroadcastTerminal 将 Agent 回传的终端消息广播给该设备的所有终端订阅者。
// 非阻塞写入各自 channel，通道满时 drain 旧消息推送最新，仍失败则丢弃并记录日志。
func BroadcastTerminal(deviceID string, data []byte) {
	GlobalHub.mu.RLock()
	defer GlobalHub.mu.RUnlock()

	subs := GlobalHub.TerminalSubscribers[deviceID]
	for _, ch := range subs {
		select {
		case ch <- data:
			// 正常发送
		default:
			// 通道满：drain 掉最旧的终端消息，然后推送最新的
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- data:
			default:
				log.Printf("[Terminal] broadcast to device %s dropped terminal message (channel full)", deviceID)
			}
		}
	}
}
