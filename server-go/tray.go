package main

import (
	"bytes"
	"embed"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/tailscale/systray"
)

//go:embed assets/favicon32.ico
var iconFS embed.FS

//go:embed assets/favicon32.png
var iconPNG []byte

// 托盘运行时状态
var (
	colorIconData []byte // 彩色原版图标（来自 favicon32.ico）
	grayIconData  []byte // 运行时生成的灰色版图标

	currentRunning bool // 当前服务是否运行中
	statusMu       sync.Mutex

	// 菜单项引用（用于动态刷新）
	statusItem *systray.MenuItem
	toggleItem *systray.MenuItem

	// systray 就绪信号：onReady 触发时关闭。
	// tailscale/systray 在 initInstance 失败时只打印错误并继续跑消息循环
	// （进程不退、图标不显、永不重试），会形成占着单实例互斥锁的"僵尸托盘"。
	// 用该信号 + 超时实现 fail-fast：onReady 没触发就退出进程，释放互斥锁让 watchdog 重拉。
	trayReadyCh   = make(chan struct{})
	trayReadyOnce sync.Once
)

func init() {
	// 读取彩色 ICO
	if data, err := iconFS.ReadFile("assets/favicon32.ico"); err == nil {
		colorIconData = data
	}
	// 运行时从 PNG 生成灰色 ICO（避免新增资源文件）
	grayIconData = generateGrayICO()
}

// generateGrayICO 从 favicon32.png 解码 → 灰度化 → 封装为 ICO
// 封装格式：6 字节 ICO header + 16 字节 directory entry + PNG data
func generateGrayICO() []byte {
	img, err := png.Decode(bytes.NewReader(iconPNG))
	if err != nil {
		log.Printf("[Tray] decode favicon32.png failed: %v, fallback to color icon for gray state", err)
		return colorIconData
	}
	bounds := img.Bounds()
	grayImg := image.NewRGBA(bounds)
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			r, g, b, a := img.At(x, y).RGBA()
			// 灰度公式 (Rec. 601 luma)；RGBA() 返回 16 位预乘，>>8 回到 8 位
			luma := uint32(float64(r)*0.3 + float64(g)*0.59 + float64(b)*0.11)
			luma8 := uint8(luma >> 8)
			grayImg.Set(x, y, color.RGBA{R: luma8, G: luma8, B: luma8, A: uint8(a >> 8)})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, grayImg); err != nil {
		log.Printf("[Tray] encode gray png failed: %v, fallback to color icon", err)
		return colorIconData
	}
	return buildICOFromPNG(buf.Bytes(), bounds.Dx(), bounds.Dy())
}

// buildICOFromPNG 把 PNG bytes 封装为单图 ICO（PNG-based icon，Win Vista+ 支持）
func buildICOFromPNG(pngData []byte, width, height int) []byte {
	ico := make([]byte, 6+16+len(pngData))
	// ICONDIR header
	binary.LittleEndian.PutUint16(ico[0:2], 0) // reserved
	binary.LittleEndian.PutUint16(ico[2:4], 1) // type = 1 (icon)
	binary.LittleEndian.PutUint16(ico[4:6], 1) // count = 1
	// ICONDIRENTRY
	w := byte(width)
	if width >= 256 {
		w = 0 // ICO 用 0 表示 256
	}
	h := byte(height)
	if height >= 256 {
		h = 0
	}
	ico[6] = w
	ico[7] = h
	ico[8] = 0  // colors (0 = no palette)
	ico[9] = 0  // reserved
	binary.LittleEndian.PutUint16(ico[10:12], 1)                  // planes
	binary.LittleEndian.PutUint16(ico[12:14], 32)                 // bit count
	binary.LittleEndian.PutUint32(ico[14:18], uint32(len(pngData))) // size
	binary.LittleEndian.PutUint32(ico[18:22], 22)                 // offset = 6 + 16
	copy(ico[22:], pngData)
	return ico
}

// checkServiceStatus 组合检查：服务处于 Running 状态 + :38921 端口可连通
func checkServiceStatus() bool {
	if !isServiceRunning("ExhibitionHub") {
		return false
	}
	return waitPortListening(":38921", 1*time.Second)
}

// applyTrayState 根据运行状态刷新图标、Tooltip、菜单文字；仅在状态变化时更新
func applyTrayState(running bool) {
	statusMu.Lock()
	changed := running != currentRunning
	currentRunning = running
	statusMu.Unlock()

	if !changed {
		return
	}

	prev := !running
	log.Printf("[Tray] Service status changed: %v -> %v", prev, running)

	if running {
		systray.SetIcon(colorIconData)
		systray.SetTooltip("展厅远程控制 (运行中)")
		statusItem.SetTitle("服务状态: 运行中")
		toggleItem.SetTitle("停止服务")
	} else {
		systray.SetIcon(grayIconData)
		systray.SetTooltip("展厅远程控制 (已停止)")
		statusItem.SetTitle("服务状态: 已停止")
		toggleItem.SetTitle("启动服务")
	}
}

// writeTrayHeartbeat 更新托盘心跳文件：证明"systray 已就绪且进程存活"。
// 服务（Session 0）无法跨 session 读取用户态 named mutex，用这个文件代替：
// watchdog 校验心跳新鲜且 session 匹配，比"进程存在"更能代表托盘图标真的在。
func writeTrayHeartbeat() {
	if err := os.MkdirAll(filepath.Dir(trayHeartbeatPath), 0755); err != nil {
		return
	}
	content := fmt.Sprintf("%d %d %d\n", currentSessionID(), os.Getpid(), time.Now().Unix())
	_ = os.WriteFile(trayHeartbeatPath, []byte(content), 0644)
}

// startStatusPoller 启动 5 秒间隔的状态轮询 goroutine
func startStatusPoller() {
	go func() {
		// 首次立即检测
		applyTrayState(checkServiceStatus())
		writeTrayHeartbeat()
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			applyTrayState(checkServiceStatus())
			writeTrayHeartbeat()
		}
	}()
}

// markTrayReady 标记 systray 初始化成功（库在 initInstance+createMenu 都成功后才触发 onReady）。
func markTrayReady() {
	trayReadyOnce.Do(func() { close(trayReadyCh) })
}

func startTray() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// 就绪看门狗：正常时 onReady 立即触发（关闭 trayReadyCh）。
	// 若 20s 内未触发，说明库初始化失败且进程不退，主动退出释放互斥锁，让 watchdog 重新拉起。
	go func() {
		select {
		case <-trayReadyCh:
		case <-time.After(20 * time.Second):
			log.Println("[Tray] FATAL: systray onReady not fired within 20s (init failed), exiting to release mutex for watchdog retry")
			os.Exit(1)
		}
	}()

	systray.Run(onReady, onExit)
}

func onReady() {
	markTrayReady()

	// 初始图标先用彩色，等首次轮询结果出来再决定
	systray.SetIcon(colorIconData)
	systray.SetTooltip("展厅远程控制")
	systray.SetOnTapped(func() { openConsole() })

	// 1. 顶部只读状态项（灰色不可点）
	statusItem = systray.AddMenuItem("服务状态: 检测中...", "")
	statusItem.Disable()

	// 2. 操作子菜单
	opMenu := systray.AddMenuItem("操作", "")
	openItem := opMenu.AddSubMenuItem("打开控制台", "")
	// 动态启停项：初始文字依据首次轮询，这里先给个默认值
	toggleItem = opMenu.AddSubMenuItem("停止服务", "")
	restartItem := opMenu.AddSubMenuItem("重启服务", "")

	// 3. 卸载
	uninstallItem := systray.AddMenuItem("卸载", "")

	// 4. 退出
	quitItem := systray.AddMenuItem("退出", "")

	// 打开控制台
	go func() { for range openItem.ClickedCh { openConsole() } }()

	// 启动/停止服务（动态）
	go func() {
		for range toggleItem.ClickedCh {
			statusMu.Lock()
			running := currentRunning
			statusMu.Unlock()
			if running {
				log.Println("[Tray] User requested: stop service")
				quietCmd("sc.exe", "stop", "ExhibitionHub").Run()
				// 等服务进入 Stopped（最多 5 秒）
				for i := 0; i < 5; i++ {
					if !isServiceRunning("ExhibitionHub") {
						break
					}
					time.Sleep(1 * time.Second)
				}
			} else {
				log.Println("[Tray] User requested: start service")
				quietCmd("sc.exe", "start", "ExhibitionHub").Run()
				// 等端口监听（最多 15 秒），轮询任务会在下个周期刷新 UI
				waitPortListening(":38921", 15*time.Second)
			}
			// 立即触发一次状态刷新（不等下个周期）
			applyTrayState(checkServiceStatus())
		}
	}()

	// 重启服务
	go func() {
		for range restartItem.ClickedCh {
			log.Println("[Tray] Restarting service...")
			quietCmd("sc.exe", "stop", "ExhibitionHub").Run()
			for i := 0; i < 5; i++ {
				if !isServiceRunning("ExhibitionHub") {
					break
				}
				time.Sleep(1 * time.Second)
			}
			quietCmd("sc.exe", "start", "ExhibitionHub").Run()
			waitPortListening(":38921", 15*time.Second)
			applyTrayState(checkServiceStatus())
		}
	}()

	// 卸载
	go func() {
		for range uninstallItem.ClickedCh {
			log.Println("[Tray] Uninstalling...")
			if !isAdmin() {
				exe, _ := os.Executable()
				exec.Command("powershell", "-Command", "Start-Process", "-Verb", "RunAs", exe, "--uninstall").Run()
			} else {
				uninstallService()
			}
			systray.Quit()
		}
	}()

	// 退出：先停服务再退托盘（共存共亡）
	go func() {
		for range quitItem.ClickedCh {
			log.Println("[Tray] Quit requested, stopping service + exiting tray")
			statusMu.Lock()
			running := currentRunning
			statusMu.Unlock()
			if running {
				quietCmd("sc.exe", "stop", "ExhibitionHub").Run()
				// 等最多 5 秒服务进入 Stopped
				for i := 0; i < 5; i++ {
					if !isServiceRunning("ExhibitionHub") {
						break
					}
					time.Sleep(1 * time.Second)
				}
			}
			systray.Quit()
		}
	}()

	// 启动状态轮询
	startStatusPoller()

	log.Println("[Tray] Systray ready")
}

func onExit() {
	log.Println("[Tray] Systray exited")
}

func openConsole() {
	log.Printf("[Tray] Opening http://localhost:38921")
	exec.Command("rundll32", "url.dll,FileProtocolHandler", "http://localhost:38921").Start()
}
