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
}

type DeviceStorage struct {
	KnownDevices      []KnownDevice     `json:"known_devices"`
	DiscoveredDevices map[string]bool   `json:"discovered_devices"` // device IDs that connected but not yet added
}

type FrameMsg struct {
	MsgType int
	Payload []byte
}

type DeviceHub struct {
	mu                 sync.RWMutex
	Agents             map[string]*websocket.Conn                        // 存放 Rust 被控端的 WS 连接
	DeviceInfos        map[string]DeviceInfo                             // 存放设备信息
	LatestFrame        map[string][]byte                                 // 存放最新一帧完整的画面作为缩略图
	Subscribers        map[string]map[*websocket.Conn]bool               // 存放订阅特定设备画面流的第三方应用连接
	SubscriberChannels map[string]map[*websocket.Conn]chan FrameMsg      // 订阅者缓冲通道，帧满时 drain 旧帧
	DeviceStorage      *DeviceStorage                                    // 持久化设备存储
}

var GlobalHub = &DeviceHub{
	Agents:             make(map[string]*websocket.Conn),
	DeviceInfos:        make(map[string]DeviceInfo),
	LatestFrame:        make(map[string][]byte),
	Subscribers:        make(map[string]map[*websocket.Conn]bool),
	SubscriberChannels: make(map[string]map[*websocket.Conn]chan FrameMsg),
	// DeviceStorage is set in InitRouter
}

func dataDir() string {
	dir := filepath.Join("data")
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
	if err := os.WriteFile(storagePath(), data, 0644); err != nil {
		log.Printf("[Hub] Error writing device storage: %v", err)
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
		return
	}

	// Device not known yet — mark as discovered if not already
	if !GlobalHub.DeviceStorage.DiscoveredDevices[id] {
		GlobalHub.DeviceStorage.DiscoveredDevices[id] = true
		go saveDeviceStorage()
	}

	// Still put in DeviceInfos so we can query non-added devices
	info.Online = true
	info.Added = false
	GlobalHub.DeviceInfos[id] = info
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

	// Update DeviceInfos
	if info, exists := GlobalHub.DeviceInfos[id]; exists {
		info.Added = false
		info.Order = 0
		info.Tags = []string{}
		GlobalHub.DeviceInfos[id] = info
	}

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
