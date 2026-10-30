package hub

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
)

// handleWake 远程开机（Wake-on-LAN）：向局域网广播 Magic Packet 唤醒目标电脑。
// MAC 来源：优先 DeviceInfos（在线/实时），其次 KnownDevice（持久化 MAC）。
// 无 MAC 或格式非法（非 12 位十六进制）时返回明确错误。
func handleWake(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "method not allowed"})
		return
	}
	var req struct {
		DeviceID string `json:"device_id"`
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

	// 查 MAC：优先 DeviceInfos，其次持久化的 KnownDevice.MAC
	mac := ""
	GlobalHub.mu.RLock()
	if info, ok := GlobalHub.DeviceInfos[req.DeviceID]; ok {
		mac = info.MAC
	}
	GlobalHub.mu.RUnlock()
	if mac == "" {
		if kd := GetKnownDevice(req.DeviceID); kd != nil {
			mac = kd.MAC
		}
	}

	clean := strings.NewReplacer(":", "", "-", "", " ", "").Replace(strings.ToUpper(strings.TrimSpace(mac)))
	if len(clean) != 12 || !isHexString(clean) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   "该设备无有效的 MAC 信息，无法远程开机",
		})
		return
	}

	// 构造 Magic Packet：6×0xFF + 16×目标MAC(6字节)
	packet := make([]byte, 6+16*6)
	for i := 0; i < 6; i++ {
		packet[i] = 0xFF
	}
	macBytes := make([]byte, 6)
	for i := 0; i < 6; i++ {
		val, _ := strconv.ParseUint(clean[i*2:i*2+2], 16, 8)
		macBytes[i] = byte(val)
	}
	for i := 0; i < 16; i++ {
		copy(packet[6+i*6:], macBytes)
	}

	// 广播目标：全局广播 + 按 Hub 本机 IP 网段推导的定向广播（跨网段更可靠）
	localIP := GetLocalIP()
	targets := []string{"255.255.255.255:9"}
	if ip := net.ParseIP(localIP); ip != nil && ip.To4() != nil {
		parts := strings.Split(localIP, ".")
		if len(parts) == 4 {
			targets = append(targets, fmt.Sprintf("%s.%s.%s.255:9", parts[0], parts[1], parts[2]))
		}
	}

	sentTargets := []string{}
	for _, addr := range targets {
		if err := sendMagicPacket(packet, addr); err != nil {
			log.Printf("[Wake] send to %s failed: %v", addr, err)
			continue
		}
		sentTargets = append(sentTargets, addr)
	}
	if len(sentTargets) == 0 {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   "唤醒包发送失败（UDP 广播不可用）",
		})
		return
	}

	formattedMAC := fmt.Sprintf("%s-%s-%s-%s-%s-%s",
		clean[0:2], clean[2:4], clean[4:6], clean[6:8], clean[8:10], clean[10:12])
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data": map[string]interface{}{
			"sent":      true,
			"mac":       formattedMAC,
			"device_id": req.DeviceID,
			"targets":   sentTargets,
		},
	})
}

func isHexString(s string) bool {
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func sendMagicPacket(packet []byte, addr string) error {
	conn, err := net.Dial("udp", addr)
	if err != nil {
		return err
	}
	defer conn.Close()
	_, err = conn.Write(packet)
	return err
}