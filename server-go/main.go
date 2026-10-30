package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"exhibition-hub/hub"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

//go:embed dist/*
var frontendFS embed.FS

//go:embed agent-bin/exhibition-agent.exe
var agentExeData []byte

type rotatingWriter struct {
	mu        sync.Mutex
	dir       string
	filename  string
	maxSize   int64
	maxBackup int
	file      *os.File
	size      int64
}

func (w *rotatingWriter) Write(p []byte) (n int, err error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.size+int64(len(p)) > w.maxSize && w.file != nil {
		w.rotate()
	}

	if w.file == nil {
		if err = w.open(); err != nil {
			return 0, err
		}
	}

	n, err = w.file.Write(p)
	w.size += int64(n)
	return
}

func (w *rotatingWriter) open() error {
	if err := os.MkdirAll(w.dir, 0755); err != nil {
		return err
	}
	path := filepath.Join(w.dir, w.filename)
	info, err := os.Stat(path)
	if err == nil {
		w.size = info.Size()
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	w.file = f
	return nil
}

func (w *rotatingWriter) rotate() {
	if w.file != nil {
		w.file.Close()
	}

	oldest := filepath.Join(w.dir, fmt.Sprintf("%s.%d", w.filename, w.maxBackup))
	os.Remove(oldest)

	for i := w.maxBackup - 1; i >= 1; i-- {
		src := filepath.Join(w.dir, fmt.Sprintf("%s.%d", w.filename, i))
		dst := filepath.Join(w.dir, fmt.Sprintf("%s.%d", w.filename, i+1))
		os.Rename(src, dst)
	}

	current := filepath.Join(w.dir, w.filename)
	backup := filepath.Join(w.dir, w.filename+".1")
	os.Rename(current, backup)

	w.file = nil
	w.size = 0
}

func initLogger() {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		localAppData = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
	}
	logDir := filepath.Join(localAppData, "ExhibitionHub", "logs")
	writer, err := newRotatingWriter(logDir, "app.log", 50*1024*1024, 5)
	if err != nil {
		log.Printf("[Logger] Failed to create rotating writer at %s: %v, falling back to stderr", logDir, err)
		return
	}
	log.SetOutput(writer)
	log.Printf("[Logger] Rotating log initialized: %s", logDir)
}

func newRotatingWriter(dir, filename string, maxSize int64, maxBackup int) (*rotatingWriter, error) {
	w := &rotatingWriter{
		dir:       dir,
		filename:  filename,
		maxSize:   maxSize,
		maxBackup: maxBackup,
	}
	if err := w.open(); err != nil {
		return nil, err
	}
	return w, nil
}

func startMonitor() {
	go func() {
		for {
			time.Sleep(5 * time.Minute)
			var m runtime.MemStats
			runtime.ReadMemStats(&m)
			log.Printf("[Monitor] goroutines=%d, alloc=%d MB, sys=%d MB, numGC=%d",
				runtime.NumGoroutine(),
				m.Alloc/(1024*1024),
				m.Sys/(1024*1024),
				m.NumGC)
		}
	}()
}

func main() {
	initLogger()
	startMonitor()

	standalone := flag.Bool("standalone", false, "Run as standalone HTTP server (for debugging)")
	serviceMode := flag.Bool("service", false, "Run as Windows service (SCM only)")
	updateMode := flag.Bool("update", false, "Update service binary (elevated only)")
	reinstallMode := flag.Bool("reinstall", false, "Force reinstall: stop service, overwrite exe, rewrite service+registry, start tray")
	uninstall := flag.Bool("uninstall", false, "Uninstall service")
	trayMode := flag.Bool("tray", false, "Tray-only mode (user session): NO HTTP, just tray icon + health check")
	flag.Parse()

	// ── 模式 1: 纯托盘（用户 Session 专用，不抢端口，不启 HTTP，不调提权）──
	if *trayMode {
		runTrayOnlyMode()
		return
	}

	// 启动兜底：上次更新因 AV/句柄占着写不进去时，这次启动如果检测到 pending 就替换
	applyPendingReplacement()

	if *uninstall {
		uninstallService()
		return
	}

	// --reinstall：不管当前是否已安装，强制完整重装一次（停止/删除→写exe→sc create→注册表→启动托盘）
	// 用例：用户双击 Program Files 下的 exe 想覆盖自身（currentExe == installedPath 无法触发正常更新路径）
	if *reinstallMode {
		log.Println("[Reinstall] Forcing reinstall...")
		if !isAdmin() {
			log.Println("[Reinstall] Elevating...")
			exe, _ := os.Executable()
			quietCmd("powershell", "-NoProfile", "-Command", "Start-Process", "-Verb", "RunAs", exe, "--reinstall").Run()
			return
		}
		updateInstalledBinaryWithUI(true) // true = 强制重建 sc create/注册表
		ensureTrayInUserSession()
		return
	}

	// --update 模式：由非提权进程通过 UAC 调用，只做二进制+服务更新不启动托盘
	if *updateMode {
		log.Println("[Update] Stopping service + updating binary...")
		updateInstalledBinaryWithUI(false) // false = 只更新二进制+重启服务，不重建 sc create/注册表
		log.Println("[Update] Complete, exiting.")
		return
	}

	// --standalone 模式：直接启动 HTTP 服务器（调试用，前台运行）
	if *standalone {
		runStandalone()
		return
	}

	// --service 模式：由 SCM 启动，注册服务 + 启动 HTTP
	if *serviceMode {
		log.Println("[Service] ExhibitionHub service starting...")
		if idx, err := frontendFS.ReadFile("dist/index.html"); err == nil {
			log.Printf("[Service] dist/index.html embedded OK, size: %d bytes", len(idx))
		} else {
			log.Printf("[Service] ERROR: dist/index.html NOT FOUND in embed: %v", err)
		}
		svc.Run("ExhibitionHub", &hubService{})
		return
	}

	// 托盘模式：检查服务是否已安装
	serviceInstalled := false
	if m, err := mgr.Connect(); err == nil {
		if s, err := m.OpenService("ExhibitionHub"); err == nil {
			serviceInstalled = true
			s.Close()
		}
		m.Disconnect()
	}

	installDir := `C:\Program Files\ExhibitionHub`
	installedPath := filepath.Join(installDir, "exhibition-hub.exe")

	if serviceInstalled {
		currentExe, _ := os.Executable()
		if !strings.EqualFold(currentExe, installedPath) {
			// 从"非安装目录"启动的新exe → 需要覆盖安装目录
			log.Println("[Hub] Detected new version, updating service binary...")
			if !isAdmin() {
				log.Println("[Hub] Elevating for update...")
				quietCmd("powershell", "-NoProfile", "-Command", "Start-Process", "-Verb", "RunAs", currentExe, "--update").Run()
				log.Println("[Hub] Update process completed, continuing...")
			} else {
				updateInstalledBinaryWithUI(false)
			}
			if isAdmin() {
				// 管理员提权窗口只做更新，用户托盘交给用户自己 session 的进程（通过 ensureTrayInUserSession）
				ensureTrayInUserSession()
				return
			}
			// 非提权进程：更新完成后继续（等待服务+托盘）
		}
		// 确保服务在运行 + HTTP 端口真正监听（否则托盘打开浏览器显示"无法连接"）
		if !isServiceRunning("ExhibitionHub") {
			log.Println("[Hub] Starting ExhibitionHub service...")
			quietCmd("sc.exe", "start", "ExhibitionHub").Run()
		}
		if waitPortListening(":38921", 15*time.Second) {
			log.Println("[Hub] :38921 listening confirmed, proceeding to tray")
		} else {
			log.Println("[Hub] :38921 not ready after 15s (service may still be starting), tray user can retry via menu")
		}
		// 如果当前在 Session 0 (管理员提权了但UAC创建成服务session了？) 或者非交互式 Session，
		// 就不阻塞在 startTray（会失败），而是在用户 Session 起一个 --tray 子进程
		if !isInteractiveUserSession() {
			log.Printf("[Hub] Current session is not interactive user session (sid=%d), spawning --tray in user session instead", currentSessionID())
			ensureTrayInUserSession()
			return
		}
		killOtherHubProcesses()
		log.Println("[Hub] About to start tray...")
		startTray()
		log.Println("[Hub] Tray returned, exiting")
		return
	}

	// 服务未安装 — 提权安装
	if !isAdmin() {
		exe, _ := os.Executable()
		quietCmd("powershell", "-NoProfile", "-Command", "Start-Process", "-Verb", "RunAs", exe).Start()
		return
	}
	installServiceWithUI()
	// 首次安装：等服务启动+端口监听
	if waitPortListening(":38921", 20*time.Second) {
		log.Println("[Install] :38921 listening confirmed")
	} else {
		log.Println("[Install] :38921 not ready after 20s (SCM slow)")
	}
	ensureTrayInUserSession()
}

// updateInstalledBinaryWithUI 以安装进度窗口方式执行二进制更新（--update / --reinstall / 覆盖安装共用）
func updateInstalledBinaryWithUI(fullReinstall bool) {
	runInstallWithUI(func(ctx *InstallCtx) {
		stepCount := 0
		statusFn := func(text string) {
			stepCount++
			ctx.Update(stepCount*11, text)
		}
		updateInstalledBinary(fullReinstall, statusFn)
	})
}

// installServiceWithUI 以安装进度窗口方式执行首次安装
func installServiceWithUI() {
	runInstallWithUI(func(ctx *InstallCtx) {
		stepCount := 0
		statusFn := func(text string) {
			stepCount++
			ctx.Update(stepCount*11, text)
		}
		installService(statusFn)
	})
}

func initHub() {
	hub.AgentDownloadData = agentExeData
	initStaticRoutes()
	hub.InitRouter()
	go startHubDiscovery()
}

const hubDiscoveryPort = 38922

// discoverySharedKey 与 Agent 内置的 DISCOVERY_SHARED_KEY 保持一致：
// 回复必须带 HMAC-SHA256 签名，防止局域网任意主机伪造 HUB_AT 劫持 Agent 连接。
const discoverySharedKey = "ExhibitionRemoteControl.HubDiscovery.2026.S3"

// startHubDiscovery 监听 UDP 广播，响应 Agent 的局域网自动发现请求。
// Agent 连不上配置的 Hub 地址（如 Hub 换了 IP）时，会向网段广播
// "WHO_IS_EXHIBITION_HUB"，Hub 回复 "HUB_AT:<ip>:<port>:<nonce>:<hmac>"，
// Agent 校验签名通过后才采用新地址——Hub 换 IP 后无需重装/改配置即可找回。
func startHubDiscovery() {
	addr := fmt.Sprintf(":%d", hubDiscoveryPort)
	pc, err := net.ListenPacket("udp4", addr)
	if err != nil {
		log.Printf("[Discovery] UDP listen on %s failed: %v", addr, err)
		return
	}
	defer pc.Close()
	log.Printf("[Discovery] UDP discovery listening on :%d (agents auto-find hub on LAN)", hubDiscoveryPort)
	buf := make([]byte, 512)
	for {
		n, from, err := pc.ReadFrom(buf)
		if err != nil {
			continue
		}
		if strings.TrimSpace(string(buf[:n])) == "WHO_IS_EXHIBITION_HUB" {
			ip := hub.GetLocalIP()
			nonce := time.Now().UnixNano()
			payload := fmt.Sprintf("HUB_AT:%s:%d:%d", ip, 38921, nonce)
			mac := hmac.New(sha256.New, []byte(discoverySharedKey))
			mac.Write([]byte(payload))
			sig := hex.EncodeToString(mac.Sum(nil))
			reply := fmt.Sprintf("%s:%s", payload, sig)
			if _, werr := pc.WriteTo([]byte(reply), from); werr == nil {
				log.Printf("[Discovery] Replied signed 'HUB_AT:%s:%d' to %s", ip, 38921, from)
			} else {
				log.Printf("[Discovery] Reply to %s failed: %v", from, werr)
			}
		}
	}
}

// quietCmd 创建一个不弹控制台窗口的子进程（避免 sc.exe/reg.exe/powershell 等闪烁）
func quietCmd(name string, arg ...string) *exec.Cmd {
	cmd := exec.Command(name, arg...)
	cmd.SysProcAttr = &windows.SysProcAttr{HideWindow: true}
	return cmd
}

// addHubFirewallRules 放行 Hub 的 LAN 入站端口：
//   - TCP :38921 —— HTTP API + WebSocket（Agent 注册/控制通道）
//   - UDP :38922 —— Agent 自动发现端口
//
// 背景：GUI 子系统服务默认被 Windows 防火墙阻止 LAN 入站。
// Agent 依赖 UDP 自动发现应对「Hub 主机更换静态 IP」场景：Hub 换 IP 后 Agent 断线，
// 重连失败累计 3 次会广播 WHO_IS_EXHIBITION_HUB 寻找新 Hub；若 UDP :38922 被防火墙拦截，
// 自动发现失效，只能人工重启 Agent 或改配置，违背「免运维自动恢复」目标。
func addHubFirewallRules(exePath string) {
	addRule := func(ruleName, protocol, port string) {
		out, err := quietCmd("netsh", "advfirewall", "firewall", "add", "rule",
			ruleName, "dir=in", "action=allow",
			"protocol="+protocol, "localport="+port,
			fmt.Sprintf("program=%s", exePath)).CombinedOutput()
		if err != nil {
			log.Printf("[FW] rule add %s %s/%s (may already exist): %v, out=%s", ruleName, protocol, port, err, string(out))
		} else {
			log.Printf("[FW] rule added: %s %s/%s", ruleName, protocol, port)
		}
	}
	addRule("name=ExhibitionHub", "TCP", "38921")
	addRule("name=ExhibitionHub-UDP", "UDP", "38922")
}

func isAdmin() bool {
	_, err := os.Open("\\\\.\\PHYSICALDRIVE0")
	return err == nil
}

// isServiceRunning 检查指定服务是否正在运行
func isServiceRunning(name string) bool {
	if m, err := mgr.Connect(); err == nil {
		if s, err := m.OpenService(name); err == nil {
			status, err := s.Query()
			s.Close()
			m.Disconnect()
			return err == nil && status.State == svc.Running
		}
		m.Disconnect()
	}
	return false
}

// killOtherHubProcesses 关闭其他 exhibition-hub.exe 进程（避免重复托盘/句柄占用）
// 同步等待所有目标进程退出，避免后续 Delete/WriteFile 命中正在退出的进程句柄
func killOtherHubProcesses() {
	selfPID := os.Getpid()
	cmd := quietCmd("powershell", "-NoProfile", "-Command",
		fmt.Sprintf(`$p = Get-Process exhibition-hub -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne %d }; if ($p) { $p | Stop-Process -Force; $p | Wait-Process -Timeout 5 -ErrorAction SilentlyContinue }`, selfPID))
	_ = cmd.Run()
	time.Sleep(1 * time.Second)
}

// writeInstalledBinaryBestEffort 尽力把当前 exe 写到安装目录
// 策略顺序（解决 AV/Defender/残留句柄导致的 Access denied）：
//  1. 直接 WriteFile(installedPath) 常规路径
//  2. 把已有的 installedPath 重命名成 .old-<ts>（同卷 rename 不需要搬数据，且不触发 AV 新建拦截），再 WriteFile
//  3. 以上都失败：先写 %TEMP% 临时文件 → 用 cmd /c move /y 强制搬过去（绕开某些 AV 对同一 API 连续写入的 heuristics）
func writeInstalledBinaryBestEffort(installedPath string, data []byte) error {
	// 1. 直接写
	if err := os.WriteFile(installedPath, data, 0755); err == nil {
		return nil
	} else {
		log.Printf("[WriteFallback1] direct WriteFile failed: %v, try rename-swap", err)
	}
	// 2. rename swap（如果旧文件存在的话）
	if info, err := os.Stat(installedPath); err == nil && !info.IsDir() {
		swapPath := fmt.Sprintf("%s.old-%d", installedPath, time.Now().Unix())
		if err2 := os.Rename(installedPath, swapPath); err2 == nil {
			log.Printf("[WriteFallback1] renamed old -> %s", swapPath)
			if err3 := os.WriteFile(installedPath, data, 0755); err3 == nil {
				// 顺手把 .old 加个延迟删除：新 exe 跑起来后下次启动就清掉了
				_ = os.Remove(swapPath)
				return nil
			} else {
				log.Printf("[WriteFallback1] post-rename WriteFile still failed: %v", err3)
			}
		} else {
			log.Printf("[WriteFallback1] rename old failed: %v", err2)
		}
	}
	// 3. 写 temp + cmd move
	tmp, err := os.CreateTemp("", "exhibition-hub-*.exe")
	if err != nil {
		return fmt.Errorf("CreateTemp failed: %w", err)
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("Write tmp failed: %w", err)
	}
	tmp.Close()
	out, err2 := quietCmd("cmd.exe", "/c", "move", "/y", tmpPath, installedPath).CombinedOutput()
	if err2 == nil {
		return nil
	}
	_ = os.Remove(tmpPath)
	return fmt.Errorf("cmd move failed: %w, out=%s", err2, strings.TrimSpace(string(out)))
}

// waitPortListening 阻塞等待指定端口被监听（默认 :38921），用于开浏览器前确保 HTTP 服务已就绪
func waitPortListening(port string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		c, err := net.DialTimeout("tcp", "127.0.0.1"+port, 200*time.Millisecond)
		if err == nil {
			_ = c.Close()
			return true
		}
		time.Sleep(250 * time.Millisecond)
	}
	return false
}

// removeOldSwapFiles 删除上次更新留下的 .old-* / .pending 垃圾文件
func removeOldSwapFiles(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var merr error
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, "exhibition-hub.exe.old-") ||
			strings.HasSuffix(name, ".pending") {
			full := filepath.Join(dir, name)
			if err := os.Remove(full); err != nil {
				merr = err
			} else {
				log.Printf("[Cleanup] removed stale %s", full)
			}
		}
	}
	return merr
}

// applyPendingReplacement 启动时如果发现 pending 新包（上次更新因句柄被占没写进去），在下次启动时兜底替换
func applyPendingReplacement() {
	installDir := `C:\Program Files\ExhibitionHub`
	pending := filepath.Join(installDir, "exhibition-hub.exe.pending")
	target := filepath.Join(installDir, "exhibition-hub.exe")
	if _, err := os.Stat(pending); err != nil {
		return
	}
	data, rerr := os.ReadFile(pending)
	if rerr != nil {
		return
	}
	log.Printf("[Pending] Found pending=%d bytes, try replacing %s now...", len(data), target)
	if err := writeInstalledBinaryBestEffort(target, data); err != nil {
		log.Printf("[Pending] Replace still failed: %v (will retry next boot)", err)
		return
	}
	_ = os.Remove(pending)
	log.Println("[Pending] Replace succeeded, pending file removed")
}

// currentSessionID 返回当前进程的 Windows Session ID（Session 0 是服务隔离区，≠0才可能有桌面/托盘）
func currentSessionID() uint32 {
	var sid uint32
	if err := windows.ProcessIdToSessionId(uint32(os.Getpid()), &sid); err != nil {
		return 0
	}
	return sid
}

// isInteractiveUserSession 判断当前进程是否在「用户登录会话」中（≠Session 0 且能找到 explorer.exe 同 session）
func isInteractiveUserSession() bool {
	sid := currentSessionID()
	if sid == 0 {
		return false
	}
	// 额外防御：当前用户名下的 explorer.exe 必须在同一个 session，否则就认为无桌面可托盘
	procs, err := quietCmd("powershell", "-NoProfile", "-Command",
		fmt.Sprintf(`Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq %d } | Measure-Object | %% Count`, sid)).Output()
	if err != nil {
		// powershell 拿不到就保守放行（session!=0 本身已经过滤了服务）
		return true
	}
	n := strings.TrimSpace(string(procs))
	return n != "" && n != "0"
}

// ensureTrayInUserSession 在「当前已登录用户的 Session」里启动一个 exhibition-hub.exe --tray 进程。
// 解决 Session 0 服务进程 / UAC 管理员窗口 无法创建可见托盘的问题。
// 策略优先级（都失败则至少在当前进程用 CreateProcessAsUser-like 方式尽力而为）：
//
//	A. 当前进程本身就在用户 session → 直接 Start 当前 exe --tray（最简单，最可靠）
//	B. 当前在管理员/服务 session → 用 WTSGetActiveConsoleSessionId + WTSQueryUserToken + CreateProcessAsUser
//	C. 兜底 A→B 都不行 → 至少启动 HKCU Run 已登记的那个路径（下次登录会起效，只是这次看不到）
func ensureTrayInUserSession() {
	installedPath := `C:\Program Files\ExhibitionHub\exhibition-hub.exe`
	// 如果安装目录下的 exe 还不存在，直接跑当前 exe
	target := installedPath
	if _, err := os.Stat(installedPath); err != nil {
		if self, e2 := os.Executable(); e2 == nil {
			target = self
		}
	}
	// A) 当前进程就是用户 session → 直接起一个 --tray 子进程
	if isInteractiveUserSession() {
		// 杀一遍旧的用户态 tray 进程，避免重复图标
		killOtherHubProcesses()
		time.Sleep(500 * time.Millisecond)
		cmd := quietCmd(target, "--tray")
		if err := cmd.Start(); err == nil {
			log.Printf("[TrayLaunch] (Strategy A) Started %s --tray in current user session (sid=%d, pid=%d)", target, currentSessionID(), cmd.Process.Pid)
			return
		} else {
			log.Printf("[TrayLaunch] Strategy A failed: %v, try B", err)
		}
	}
	// B) 管理员/session0 场景：用 WTS API 找 console session，复制 token，CreateProcessAsUser。
	if err := spawnTrayAsActiveConsoleUser(target); err == nil {
		log.Printf("[TrayLaunch] (Strategy B) spawn tray via WTS token succeeded")
		return
	} else {
		log.Printf("[TrayLaunch] Strategy B CreateProcessAsUser failed: %v", err)
	}
	// C) 兜底：无法在"这次"立刻启动托盘，但至少保证 HKCU Run 有它（下次登录一定出）
	log.Printf("[TrayLaunch] (Strategy C) Fallback: tray will appear after re-login via HKCU Run entry")
}

// spawnTrayAsActiveConsoleUser 用 WTSGetActiveConsoleSessionId + WTSQueryUserToken + CreateProcessAsUser 在活动登录会话启动托盘。
// 这是"服务 → 用户桌面"跨 session 起可见进程的官方标准做法。失败返回 error，调用方可以兜底。
func spawnTrayAsActiveConsoleUser(exePath string) error {
	// 1. 取当前物理机屏幕控制台 session（RDP 的话是当前连接到的那个）
	sid := windows.WTSGetActiveConsoleSessionId()
	if sid == 0xFFFFFFFF { // WTS_ANY_SESSION / 没有活动会话
		return fmt.Errorf("no active console session")
	}
	// 2. 拿这个 session 的用户 token
	var token windows.Token
	if err := windows.WTSQueryUserToken(sid, &token); err != nil {
		return fmt.Errorf("WTSQueryUserToken(sid=%d) failed: %w", sid, err)
	}
	defer token.Close()
	// 3. 用这个 token 创建 Environment block（让子进程能看到用户的 %APPDATA% 等）
	var env *uint16
	if err := windows.CreateEnvironmentBlock(&env, token, false); err == nil {
		defer windows.DestroyEnvironmentBlock(env)
	}
	// 4. STARTUPINFO + PROCESS_INFORMATION
	si := new(windows.StartupInfo)
	si.Cb = uint32(unsafe.Sizeof(*si))
	si.Desktop = windows.StringToUTF16Ptr("winsta0\\default")
	pi := new(windows.ProcessInformation)
	flags := uint32(windows.CREATE_UNICODE_ENVIRONMENT)
	if env == nil {
		flags = 0
	}
	cmdLine := windows.StringToUTF16Ptr(`"` + exePath + `" --tray`)
	var dirPtr *uint16
	if dir := filepath.Dir(exePath); dir != "" {
		dirPtr = windows.StringToUTF16Ptr(dir)
	}
	err := windows.CreateProcessAsUser(
		token,
		nil,      // application name (use cmd line)
		cmdLine,  // command line
		nil, nil, // proc/thread attr
		false,  // inherit handles
		flags,  // creation flags
		env,    // environment
		dirPtr, // current dir
		si, pi,
	)
	if err != nil {
		return fmt.Errorf("CreateProcessAsUser failed: %w", err)
	}
	log.Printf("[TrayLaunch] CreateProcessAsUser OK: session=%d, pid=%d, tid=%d", sid, pi.ProcessId, pi.ThreadId)
	windows.CloseHandle(pi.Process)
	windows.CloseHandle(pi.Thread)
	return nil
}

// tryLockTraySingleInstance 用 named mutex 保证每个用户 Session 内只允许一个托盘进程。
// 参考 RustDesk PR #15690：用 Local\<AppName>_tray 内核对象，不受"读命令行/提权检测盲
// 点"影响。ERROR_ALREADY_EXISTS 或 ERROR_ACCESS_DENIED 都视为"已有托盘在运行"。
// 返回 true 表示本进程获得锁（可以显示图标），false 表示已有别的托盘（直接退出）。
func tryLockTraySingleInstance() bool {
	const (
		ERROR_ALREADY_EXISTS syscall.Errno = 183
		ERROR_ACCESS_DENIED  syscall.Errno = 5
	)
	name, _ := windows.UTF16PtrFromString("Local\\ExhibitionHub_tray")
	muHandle, err := windows.CreateMutex(nil, false, name)
	if err == nil {
		// 拿到锁，持有到进程退出（Windows 会在进程退出时自动释放内核对象句柄）
		_ = muHandle // 不 Close，进程死亡自动释放
		return true
	}
	if err == ERROR_ALREADY_EXISTS || err == ERROR_ACCESS_DENIED {
		log.Printf("[Tray] Single-instance mutex exists, another tray is running (err=%v). Exiting.", err)
		return false
	}
	// 其他错误（内存不足等极端情况）：宁可显示一个重复图标也比完全没有好
	log.Printf("[Tray] Single-instance CreateMutex failed (unexpected err=%v), showing icon anyway", err)
	return true
}

// runTrayOnlyMode 用户态托盘专用模式：
//  1. 不注册 HTTP，不跟 :38921 抢端口（服务进程才做 HTTP）
//  2. named mutex 单实例（防止 session 内重复图标）
//  3. 等待 explorer 就绪（开机时可能需要等待），然后创建托盘
//  4. 后台检查服务端口，不在就尝试启动
func runTrayOnlyMode() {
	sid := currentSessionID()
	log.Printf("[Tray] Mode=tray-only, session=%d, pid=%d", sid, os.Getpid())

	// 单实例 guard：发现同 session 已有托盘就静默退出（避免重复图标）
	if !tryLockTraySingleInstance() {
		return
	}

	// 等待 explorer 就绪（开机自启时 explorer 可能未完全启动）
	if !waitExplorerReady(30 * time.Second) {
		log.Println("[Tray] WARNING: explorer not ready after 30s, tray may not display")
	}

	// 后台检查服务端口
	go func() {
		if !waitPortListening(":38921", 15*time.Second) {
			log.Printf("[Tray] :38921 not ready in 15s, starting service...")
			_ = quietCmd("sc.exe", "start", "ExhibitionHub").Run()
		}
	}()

	startTray()
	log.Println("[Tray] tray message loop exited, quitting tray-only process")
}

// waitExplorerReady 等待 explorer.exe 在当前 session 中就绪（开机自启时需要）
func waitExplorerReady(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		sid := currentSessionID()
		if sid > 0 {
			// 检查 explorer 是否在当前 session 运行
			out, err := quietCmd("powershell", "-NoProfile", "-Command",
				fmt.Sprintf(`Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq %d } | Measure-Object | %% Count`, sid)).Output()
			if err == nil && strings.TrimSpace(string(out)) != "0" && strings.TrimSpace(string(out)) != "" {
				log.Printf("[Tray] explorer ready (sid=%d)", sid)
				return true
			}
		}
		time.Sleep(2 * time.Second)
	}
	log.Println("[Tray] explorer not ready after timeout")
	return false
}

// updateInstalledBinary 覆盖安装目录下的 exe + 服务控制
//
//	fullReinstall=true  — 完整重装：除了写exe，还会 sc delete → sc create + failure + 写注册表 Run
//	fullReinstall=false — 仅更新：停服务→写exe→启动服务（保留原有 sc create 配置和注册表）
//	statusFn 可选：安装进度状态回调（用于安装 UI 窗口），nil 时不回调
func updateInstalledBinary(fullReinstall bool, statusFn ...func(string)) {
	status := func(string) {}
	if len(statusFn) > 0 && statusFn[0] != nil {
		status = statusFn[0]
	}
	installDir := `C:\Program Files\ExhibitionHub`
	installedPath := filepath.Join(installDir, "exhibition-hub.exe")

	// 1. 杀托盘进程（关键！不杀的话它持有安装目录 exe 的映射句柄，WriteFile 会失败）
	log.Println("[UpdateStep1] Killing other hub processes to release file handles...")
	status("正在停止旧进程...")
	killOtherHubProcesses()
	time.Sleep(500 * time.Millisecond)

	// 2. 停止服务（sc stop），多次尝试
	log.Println("[UpdateStep2] Stopping ExhibitionHub service...")
	status("正在停止系统服务...")
	scStopErr := quietCmd("sc.exe", "stop", "ExhibitionHub").Run()
	// 忽略 sc stop 报错（可能之前没运行）
	for i := 0; i < 5; i++ {
		if !isServiceRunning("ExhibitionHub") {
			break
		}
		log.Printf("[UpdateStep2] Service still running, wait 1s... (%d/5)", i+1)
		time.Sleep(1 * time.Second)
	}
	log.Printf("[UpdateStep2] sc stop done (err=%v), isRunning=%v", scStopErr, isServiceRunning("ExhibitionHub"))

	// 3. 完整重装模式：先 sc delete（让服务配置从新创建）
	if fullReinstall {
		log.Println("[UpdateStep3-Full] sc delete ExhibitionHub (recreate service)...")
		status("正在移除旧服务定义...")
		quietCmd("sc.exe", "delete", "ExhibitionHub").Run()
		// sc delete 后 SCM 可能保留条目一段时间，等待消失
		for i := 0; i < 5; i++ {
			installed := false
			if m, err := mgr.Connect(); err == nil {
				if s, err := m.OpenService("ExhibitionHub"); err == nil {
					installed = true
					s.Close()
				}
				m.Disconnect()
			}
			if !installed {
				break
			}
			log.Printf("[UpdateStep3-Full] Service still exists, wait 1s... (%d/5)", i+1)
			time.Sleep(1 * time.Second)
		}
	}

	// 4. 准备目录
	status("正在准备安装目录...")
	if err := os.MkdirAll(installDir, 0755); err != nil {
		log.Printf("[UpdateStep4] MkdirAll failed: %v", err)
	}

	// 5. 尝试删除旧 exe（失败也没关系，后面 rename-swap 会兜底），但把旧 .old-* 先清理
	if err := removeOldSwapFiles(installDir); err != nil {
		log.Printf("[UpdateStep5] cleanup old swap files: %v", err)
	}
	if _, err := os.Stat(installedPath); err == nil {
		for attempt := 0; attempt < 10; attempt++ {
			err := os.Remove(installedPath)
			if err == nil {
				log.Printf("[UpdateStep5] Removed old %s (attempt %d)", installedPath, attempt+1)
				break
			}
			log.Printf("[UpdateStep5] Remove old exe attempt %d/10 failed: %v", attempt+1, err)
			time.Sleep(1 * time.Second)
		}
	}

	// 6. 读取当前 exe 写入安装目录（走三级兜底，解决 AV/残留句柄的 Access denied）
	status("正在复制程序文件...")
	currentExe, _ := os.Executable()
	input, err := os.ReadFile(currentExe)
	if err != nil {
		log.Printf("[UpdateStep6] FATAL: ReadFile(%s) failed: %v", currentExe, err)
		return
	}
	if werr := writeInstalledBinaryBestEffort(installedPath, input); werr != nil {
		// 所有兜底都失败的情况下，延迟到下次重启：把临时文件写到 installDir 并登记 pending（尽力而为）
		pending := filepath.Join(installDir, "exhibition-hub.exe.pending")
		_ = os.WriteFile(pending, input, 0755)
		log.Printf("[UpdateStep6] FATAL: WriteFile all fallbacks failed: %v -> wrote %s, please reboot and try again", werr, pending)
		return
	}
	outStat, _ := os.Stat(installedPath)
	log.Printf("[UpdateStep6] WriteFile OK. Input=%d bytes, Output=%d bytes, match=%v",
		len(input), outStat.Size(), int(outStat.Size()) == len(input))

	// 防火墙放行规则（GUI 子系统服务默认被防火墙阻止 LAN 入站；同时放行 UDP 自动发现端口供 Agent 寻址）
	status("正在配置防火墙...")
	addHubFirewallRules(installedPath)

	// 7. 完整重装模式：重建 SCM 服务 + 写注册表
	if fullReinstall {
		log.Println("[UpdateStep7-Full] Recreating sc create / sc failure / registry Run...")
		status("正在创建系统服务...")
		args := []string{
			"create", "ExhibitionHub",
			"binPath=", fmt.Sprintf(`"%s" --service`, installedPath),
			"start=", "auto",
		}
		if err := quietCmd("sc.exe", args...).Run(); err != nil {
			log.Printf("[UpdateStep7-Full] sc create failed: %v", err)
		} else {
			log.Println("[UpdateStep7-Full] sc create OK")
		}
		if err := quietCmd("sc.exe", "failure", "ExhibitionHub",
			"reset=", "86400",
			"actions=", "restart/5000/restart/10000/restart/30000",
		).Run(); err != nil {
			log.Printf("[UpdateStep7-Full] sc failure failed: %v", err)
		}
		if out, err := quietCmd("reg.exe", "add",
			`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`,
			"/v", "ExhibitionHubTray",
			"/t", "REG_SZ",
			"/d", fmt.Sprintf(`"%s" --tray`, installedPath),
			"/f",
		).CombinedOutput(); err != nil {
			log.Printf("[UpdateStep7-Full] reg.exe add failed: %v, out=%s", err, string(out))
		} else {
			log.Println("[UpdateStep7-Full] registry Run OK")
		}
		// 防火墙放行规则（GUI 子系统服务默认被阻止 LAN 入站；同时放行 UDP 自动发现端口）
		addHubFirewallRules(installedPath)

		if out, err := quietCmd("schtasks", "/create",
			"/tn", "ExhibitionHub",
			"/tr", fmt.Sprintf(`"%s" --tray`, installedPath),
			"/sc", "ONLOGON",
			"/rl", "HIGHEST",
			"/f",
		).CombinedOutput(); err != nil {
			log.Printf("[UpdateStep7-Full] schtasks create failed: %v, out=%s", err, string(out))
		} else {
			log.Println("[UpdateStep7-Full] schtasks create OK")
		}
	}

	// 8. 启动服务
	log.Println("[UpdateStep8] sc start ExhibitionHub...")
	status("正在启动系统服务...")
	if err := quietCmd("sc.exe", "start", "ExhibitionHub").Run(); err != nil {
		log.Printf("[UpdateStep8] sc start failed (maybe already running or not exists): %v", err)
	}
	time.Sleep(2 * time.Second)
	for i := 0; i < 5; i++ {
		if isServiceRunning("ExhibitionHub") {
			log.Printf("[UpdateStep8] Service running confirmed after %d * 1s", i+1)
			break
		}
		log.Printf("[UpdateStep8] Service not up yet, wait 1s... (%d/5)", i+1)
		time.Sleep(1 * time.Second)
	}
}

func installService(statusFn ...func(string)) {
	// installService 首次安装时也复用 updateInstalledBinary(fullReinstall=true) 逻辑
	updateInstalledBinary(true, statusFn...)

	installedPath := `C:\Program Files\ExhibitionHub\exhibition-hub.exe`

	status := func(string) {}
	if len(statusFn) > 0 && statusFn[0] != nil {
		status = statusFn[0]
	}

	// 添加 Windows 防火墙放行规则：TCP :38921 入站（HTTP+WS），UDP :38922（Agent UDP 自动发现）
	log.Println("[Install] Adding Windows Firewall rules for :38921/:38922...")
	status("正在配置防火墙...")
	addHubFirewallRules(installedPath)

	log.Println("[Install] Registering Windows scheduled task...")
	status("正在注册开机自启...")
	if out, err := quietCmd("schtasks", "/create",
		"/tn", "ExhibitionHub",
		"/tr", fmt.Sprintf(`"%s" --tray`, installedPath),
		"/sc", "ONLOGON",
		"/rl", "HIGHEST",
		"/f",
	).CombinedOutput(); err != nil {
		log.Printf("[Install] schtasks create failed: %v, out=%s", err, string(out))
	} else {
		log.Println("[Install] schtasks create OK")
	}

	log.Println("[Install] ExhibitionHub service installed successfully")
}

func uninstallService() {
	log.Println("[Uninstall] Starting uninstall...")

	// 先杀所有 hub 进程（包括托盘，它们会持有 exe 句柄导致 RemoveAll 失败）
	killOtherHubProcesses()
	time.Sleep(1 * time.Second)

	log.Println("[Uninstall] Stopping service...")
	quietCmd("sc.exe", "stop", "ExhibitionHub").Run()
	time.Sleep(2 * time.Second)
	log.Println("[Uninstall] Deleting service...")
	if err := quietCmd("sc.exe", "delete", "ExhibitionHub").Run(); err != nil {
		log.Printf("[Uninstall] sc delete: %v (may already be deleted)", err)
	}

	installDir := `C:\Program Files\ExhibitionHub`
	// 循环尝试删除安装目录（最多 10 秒，等句柄释放）
	for i := 0; i < 10; i++ {
		if err := os.RemoveAll(installDir); err == nil {
			log.Printf("[Uninstall] Removed %s", installDir)
			break
		} else {
			log.Printf("[Uninstall] RemoveAll attempt %d/10 failed: %v", i+1, err)
			time.Sleep(1 * time.Second)
		}
	}

	log.Println("[Uninstall] Removing registry Run...")
	if out, err := quietCmd("reg.exe", "delete",
		`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`,
		"/v", "ExhibitionHubTray",
		"/f",
	).CombinedOutput(); err != nil {
		log.Printf("[Uninstall] reg.exe delete: %v, out=%s (may already be removed)", err, string(out))
	}

	log.Println("[Uninstall] Removing scheduled task...")
	if out, err := quietCmd("schtasks", "/delete",
		"/tn", "ExhibitionHub",
		"/f",
	).CombinedOutput(); err != nil {
		log.Printf("[Uninstall] schtasks delete: %v, out=%s (may already be removed)", err, string(out))
	}

	log.Println("[Uninstall] ExhibitionHub service uninstalled successfully")
	fmt.Println("ExhibitionHub 已卸载。按 Enter 退出。")
	fmt.Scanln()
}

func runService() {
	log.Println("[Service] Starting ExhibitionHub on :38921...")

	// 初始化：Agent 下载数据、静态路由、API 路由、UDP 自动发现
	initHub()
	go func() {
		if isSvc, _ := svc.IsWindowsService(); isSvc {
			log.Println("[Service] Registering with Service Control Manager...")
			svc.Run("ExhibitionHub", &hubService{})
		}
	}()

	// 主线程：直接启动 HTTP 服务器
	log.Println("[Hub] ExhibitionHub HTTP server listening on :38921")
	if err := http.ListenAndServe(":38921", nil); err != nil {
		log.Fatalf("[Hub] ListenAndServe failed: %v", err)
	}
}

// runStandalone 以独立进程方式直接启动 HTTP 服务器（不依赖 SCM）
func runStandalone() {
	initHub()
	log.Println("[Hub] ExhibitionHub listening on :38921")
	if err := http.ListenAndServe(":38921", nil); err != nil {
		log.Printf("[Hub] ListenAndServe failed (non-fatal): %v", err)
	}
}

// trayHeartbeatPath 托盘就绪心跳文件路径（ProgramData 对 LocalSystem 和普通用户进程都可读写）。
const trayHeartbeatPath = `C:\ProgramData\ExhibitionHub\tray_ready`

// trayHeartbeatFresh 判断活动会话的托盘心跳是否新鲜且 session 匹配。
// 心跳只在 systray 初始化成功（onReady 触发）后由托盘每 5s 持续写入，
// 因此它是"托盘图标真的就绪"的可靠信号；进程存在但初始化失败的僵尸没有心跳。
func trayHeartbeatFresh(activeSid uint32) bool {
	data, err := os.ReadFile(trayHeartbeatPath)
	if err != nil {
		return false
	}
	var sid uint32
	var pid int
	var ts int64
	if _, err := fmt.Sscanf(string(data), "%d %d %d", &sid, &pid, &ts); err != nil {
		return false
	}
	if sid != activeSid {
		return false
	}
	return time.Since(time.Unix(ts, 0)) < 90*time.Second
}

// isTrayRunningInActiveSession 检查当前活动控制台 session 中是否有"真正就绪"的托盘在运行。
// 双条件校验：
//  1. 心跳新鲜（onReady 已触发、进程存活）—— 排除"进程在但图标没显示"的僵尸托盘；
//  2. 同 session 内存在命令行含 "--tray" 的 exhibition-hub.exe 进程。
//
// （Session 0 服务无法读取用户 session 的 named mutex「Local\」命名空间隔离，因此用
// 进程查询 + 心跳文件代替。）
func isTrayRunningInActiveSession() bool {
	activeSid := windows.WTSGetActiveConsoleSessionId()
	if activeSid == 0xFFFFFFFF {
		// 没有活动用户会话（停在登录界面 / 无用户登录）
		return false
	}
	if !trayHeartbeatFresh(activeSid) {
		return false
	}
	out, err := quietCmd("powershell", "-NoProfile", "-Command",
		fmt.Sprintf(`Get-CimInstance Win32_Process -Filter "Name='exhibition-hub.exe'" | Where-Object { ($_.SessionId -eq %d) -and ($_.CommandLine -like '*--tray*') } | Measure-Object | %% Count`, activeSid)).Output()
	if err != nil {
		log.Printf("[Watchdog] tray check powershell failed: %v, assume no tray", err)
		return false
	}
	cnt := strings.TrimSpace(string(out))
	running := cnt != "" && cnt != "0"
	return running
}

// startTrayWatchdog 在 Windows Service 内部启动托盘巡检 goroutine：每 30 秒检查
// 一次活动用户 session 内是否有托盘，若连续 2 次未发现则自动拉起。
// 收到 stopCh 后退出（服务 Stop/Shutdown 时）。
func startTrayWatchdog(stopCh <-chan struct{}) {
	installedPath := `C:\Program Files\ExhibitionHub\exhibition-hub.exe`
	target := installedPath
	if _, err := os.Stat(installedPath); err != nil {
		if self, e2 := os.Executable(); e2 == nil {
			target = self
		}
	}

	go func() {
		missCount := 0
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stopCh:
				log.Println("[Watchdog] tray watchdog stopping (service shutdown)")
				return
			case <-ticker.C:
				if isTrayRunningInActiveSession() {
					missCount = 0
					continue
				}
				missCount++
				log.Printf("[Watchdog] tray not found in active session (miss_count=%d/2)", missCount)
				if missCount >= 2 {
					// 连续 2 次未找到，尝试拉起
					log.Println("[Watchdog] tray missing for 2 checks, spawning replacement via WTS CreateProcessAsUser...")
					if err := spawnTrayAsActiveConsoleUser(target); err == nil {
						log.Println("[Watchdog] respawned tray successfully")
						missCount = 0
					} else {
						log.Printf("[Watchdog] respawn tray failed: %v (will retry in 30s)", err)
						// missCount 不清零，下次继续尝试
					}
				}
			}
		}
	}()
}

type hubService struct{}

func (m *hubService) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (ssec bool, errno uint32) {
	const cmdsAccepted = svc.AcceptStop | svc.AcceptShutdown
	changes <- svc.Status{State: svc.StartPending}

	go runStandalone()

	// 托盘 watchdog：服务常驻，自动补全意外消失的托盘
	trayStopCh := make(chan struct{})
	startTrayWatchdog(trayStopCh)

	changes <- svc.Status{State: svc.Running, Accepts: cmdsAccepted}

	for {
		select {
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				changes <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				changes <- svc.Status{State: svc.StopPending}
				close(trayStopCh) // 停止 watchdog goroutine
				return false, 0
			}
		}
	}
}

func initStaticRoutes() {
	subFS, err := fs.Sub(frontendFS, "dist")
	if err != nil {
		log.Printf("[Static] Failed to get sub FS: %v", err)
		return
	}
	fileServer := http.FileServer(http.FS(subFS))

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// API 路径不拦截
		if strings.HasPrefix(r.URL.Path, "/api/") ||
			strings.HasPrefix(r.URL.Path, "/agent/") ||
			strings.HasPrefix(r.URL.Path, "/stream") ||
			r.URL.Path == "/agents" {
			http.NotFound(w, r)
			return
		}
		// 检查文件是否存在
		path := strings.TrimPrefix(r.URL.Path, "/")
		f, err := subFS.Open(path)
		if err != nil {
			// SPA fallback: 返回 index.html
			idx, _ := frontendFS.ReadFile("dist/index.html")
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(idx)
			return
		}
		f.Close()
		fileServer.ServeHTTP(w, r)
	})
}
