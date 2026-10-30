package main

import (
	"log"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ── Win32 常量 ──
const (
	uiWS_OVERLAPPED   = 0x00000000
	uiWS_CAPTION      = 0x00C00000
	uiWS_SYSMENU      = 0x00080000
	uiWS_MINIMIZEBOX  = 0x00020000
	uiWS_VISIBLE      = 0x10000000
	uiWS_CHILD        = 0x40000000
	uiWS_CLIPCHILDREN = 0x02000000

	uiCS_HREDRAW = 0x0002
	uiCS_VREDRAW = 0x0001

	uiWS_EX_APPWINDOW = 0x00040000

	uiWM_DESTROY = 0x0002
	uiWM_SETFONT = 0x0030
	uiWM_APP     = 0x8000
	uiMSG_UPDATE = uiWM_APP + 1
	uiMSG_QUIT   = uiWM_APP + 2
	uiMSG_PROGR  = uiWM_APP + 3

	uiSS_CENTER = 0x1

	uiSW_SHOW = 5

	uiPBM_SETRANGE = 0x0401
	uiPBM_SETPOS   = 0x0402

	uiCOLOR_BTNFACE = 15
	uiFW_BOLD       = 700
	uiFW_NORMAL     = 400
)

var (
	uiUser32   = windows.NewLazySystemDLL("user32.dll")
	uiKernel32 = windows.NewLazySystemDLL("kernel32.dll")
	uiGdi32    = windows.NewLazySystemDLL("gdi32.dll")
	uiShcore   = windows.NewLazySystemDLL("shcore.dll")

	uiRegClass     = uiUser32.NewProc("RegisterClassExW")
	uiCreateWin    = uiUser32.NewProc("CreateWindowExW")
	uiDefWndProc   = uiUser32.NewProc("DefWindowProcW")
	uiGetMsg       = uiUser32.NewProc("GetMessageW")
	uiTransMsg     = uiUser32.NewProc("TranslateMessage")
	uiDispatchMsg  = uiUser32.NewProc("DispatchMessageW")
	uiPostQuit     = uiUser32.NewProc("PostQuitMessage")
	uiPostMessage  = uiUser32.NewProc("PostMessageW")
	uiSetWndText   = uiUser32.NewProc("SetWindowTextW")
	uiDestroyWnd   = uiUser32.NewProc("DestroyWindow")
	uiShowWindow   = uiUser32.NewProc("ShowWindow")
	uiUpdateWindow = uiUser32.NewProc("UpdateWindow")
	uiGetModule    = uiKernel32.NewProc("GetModuleHandleW")
	uiGetSysMetric = uiUser32.NewProc("GetSystemMetrics")
	uiSetWindowPos = uiUser32.NewProc("SetWindowPos")
	uiLoadIcon     = uiUser32.NewProc("LoadIconW")
	uiSendMessage  = uiUser32.NewProc("SendMessageW")

	uiCreateFont         = uiGdi32.NewProc("CreateFontW")
	uiSetProcessDPIAware = uiUser32.NewProc("SetProcessDPIAware")
)

type uiWndClassExW struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	HInstance  windows.Handle
	Icon       windows.Handle
	Cursor     windows.Handle
	Background windows.Handle
	MenuName   *uint16
	ClassName  *uint16
	IconSm     windows.Handle
}

type POINT struct {
	X, Y int32
}

type uiMSG struct {
	Hwnd    windows.Handle
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      POINT
}

var (
	uiStatic   windows.Handle
	uiProgress windows.Handle
	uiMainWnd  windows.Handle
	uiWndProc  uintptr
	uiStatusMu sync.Mutex
	uiStatus   string

	hFontTitle  windows.Handle
	hFontNormal windows.Handle
)

// InstallCtx 提供给安装步骤，用于精确控制进度条和文本
type InstallCtx struct {
	hwnd windows.Handle
}

// Update 更新进度条(0-100) 和状态文本
func (c *InstallCtx) Update(percent int, text string) {
	if text != "" {
		log.Println("[InstallUI]", text)
		setUIStatus(c.hwnd, text)
	}
	if percent >= 0 && percent <= 100 {
		setUIProgress(percent)
	}
}

// runInstallWithUI 优化版安装流程入口
func runInstallWithUI(stepFn func(ctx *InstallCtx)) {
	uiSetProcessDPIAware.Call()

	uiCreated := make(chan windows.Handle, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		hwnd := createInstallUIWindow()
		uiCreated <- hwnd
		if hwnd != 0 {
			uiRunMessageLoop()
		}
	}()

	hwnd := <-uiCreated
	ctx := &InstallCtx{hwnd: hwnd}

	if hwnd != 0 {
		ctx.Update(0, "正在准备安装环境...")
		time.Sleep(500 * time.Millisecond)
	}

	stepFn(ctx)

	ctx.Update(100, "安装完成！")
	time.Sleep(1500 * time.Millisecond)

	if hwnd != 0 {
		uiPostMessage.Call(uintptr(hwnd), uiMSG_QUIT, 0, 0)
		time.Sleep(300 * time.Millisecond)
	}
	log.Println("[InstallUI] install finished")
}

func createInstallUIWindow() windows.Handle {
	hinstRet, _, _ := uiGetModule.Call(0)
	hinst := windows.Handle(hinstRet)

	iconHandle, _, _ := uiLoadIcon.Call(uintptr(hinst), uintptr(1))

	uiWndProc = windows.NewCallback(uiInstallWndProc)
	className, _ := windows.UTF16PtrFromString("ExbInstallUI")

	wc := uiWndClassExW{
		Size:       uint32(unsafe.Sizeof(uiWndClassExW{})),
		Style:      uiCS_HREDRAW | uiCS_VREDRAW,
		WndProc:    uiWndProc,
		HInstance:  hinst,
		Icon:       windows.Handle(iconHandle),
		IconSm:     windows.Handle(iconHandle),
		Background: windows.Handle(uiCOLOR_BTNFACE + 1),
		ClassName:  className,
	}
	atom, _, _ := uiRegClass.Call(uintptr(unsafe.Pointer(&wc)))
	if atom == 0 {
		log.Printf("[InstallUI] RegisterClassEx failed")
		return 0
	}

	fontName, _ := windows.UTF16PtrFromString("Microsoft YaHei")
	r1, _, _ := uiCreateFont.Call(24, 0, 0, 0, uiFW_BOLD, 0, 0, 0, 134, 0, 0, 2, 0, uintptr(unsafe.Pointer(fontName)))
	hFontTitle = windows.Handle(r1)
	r2, _, _ := uiCreateFont.Call(16, 0, 0, 0, uiFW_NORMAL, 0, 0, 0, 134, 0, 0, 2, 0, uintptr(unsafe.Pointer(fontName)))
	hFontNormal = windows.Handle(r2)

	winWidth, winHeight := 520, 240
	title, _ := windows.UTF16PtrFromString("展厅远程控制 - 安装程序")
	hwndRet, _, _ := uiCreateWin.Call(
		uintptr(uiWS_EX_APPWINDOW),
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(title)),
		uintptr(uiWS_OVERLAPPED|uiWS_CAPTION|uiWS_SYSMENU|uiWS_MINIMIZEBOX|uiWS_CLIPCHILDREN),
		0, 0, uintptr(winWidth), uintptr(winHeight),
		0, 0, uintptr(hinst), 0,
	)
	hwnd := windows.Handle(hwndRet)

	centerUIWindow(hwnd, winWidth, winHeight)

	clsStatic, _ := windows.UTF16PtrFromString("STATIC")

	titleText, _ := windows.UTF16PtrFromString("展厅远程控制系统")
	staticTitle, _, _ := uiCreateWin.Call(
		0, uintptr(unsafe.Pointer(clsStatic)), uintptr(unsafe.Pointer(titleText)),
		uintptr(uiWS_CHILD|uiWS_VISIBLE|uiSS_CENTER),
		20, 30, 460, 35,
		hwndRet, 0, uintptr(hinst), 0,
	)
	uiSendMessage.Call(staticTitle, uiWM_SETFONT, uintptr(hFontTitle), 1)

	clsProg, _ := windows.UTF16PtrFromString("msctls_progress32")
	progHwnd, _, _ := uiCreateWin.Call(
		0, uintptr(unsafe.Pointer(clsProg)), 0,
		uintptr(uiWS_CHILD|uiWS_VISIBLE),
		40, 85, 420, 22,
		hwndRet, 0, uintptr(hinst), 0,
	)
	uiProgress = windows.Handle(progHwnd)
	uiSendMessage.Call(uintptr(uiProgress), uiPBM_SETRANGE, 0, 100)

	statusText, _ := windows.UTF16PtrFromString("正在准备安装...")
	staticStatus, _, _ := uiCreateWin.Call(
		0, uintptr(unsafe.Pointer(clsStatic)), uintptr(unsafe.Pointer(statusText)),
		uintptr(uiWS_CHILD|uiWS_VISIBLE|uiSS_CENTER),
		40, 125, 420, 25,
		hwndRet, 0, uintptr(hinst), 0,
	)
	uiStatic = windows.Handle(staticStatus)
	uiSendMessage.Call(uintptr(uiStatic), uiWM_SETFONT, uintptr(hFontNormal), 1)

	verText, _ := windows.UTF16PtrFromString("v1.0.0")
	staticVer, _, _ := uiCreateWin.Call(
		0, uintptr(unsafe.Pointer(clsStatic)), uintptr(unsafe.Pointer(verText)),
		uintptr(uiWS_CHILD|uiWS_VISIBLE|uiSS_CENTER),
		40, 175, 420, 20,
		hwndRet, 0, uintptr(hinst), 0,
	)
	uiSendMessage.Call(staticVer, uiWM_SETFONT, uintptr(hFontNormal), 1)

	uiMainWnd = hwnd
	uiShowWindow.Call(hwndRet, uiSW_SHOW)
	uiUpdateWindow.Call(hwndRet)
	return hwnd
}

func centerUIWindow(hwnd windows.Handle, width, height int) {
	sw, _, _ := uiGetSysMetric.Call(0)
	sh, _, _ := uiGetSysMetric.Call(1)
	x := (int(sw) - width) / 2
	y := (int(sh) - height) / 2
	uiSetWindowPos.Call(uintptr(hwnd), 0,
		uintptr(x), uintptr(y), uintptr(width), uintptr(height), 0x0004)
}

func setUIStatus(hwnd windows.Handle, text string) {
	uiStatusMu.Lock()
	uiStatus = text
	uiStatusMu.Unlock()
	if hwnd != 0 {
		uiPostMessage.Call(uintptr(hwnd), uiMSG_UPDATE, 0, 0)
	}
}

func uiSetStatusText(text string) {
	if uiStatic == 0 {
		return
	}
	p, _ := windows.UTF16PtrFromString(text)
	uiSetWndText.Call(uintptr(uiStatic), uintptr(unsafe.Pointer(p)))
}

func setUIProgress(percent int) {
	if uiProgress == 0 || uiMainWnd == 0 {
		return
	}
	uiPostMessage.Call(uintptr(uiMainWnd), uiMSG_PROGR, uintptr(percent), 0)
}

func uiApplyProgress(percent int) {
	if uiProgress == 0 {
		return
	}
	uiSendMessage.Call(uintptr(uiProgress), uiPBM_SETPOS, uintptr(percent), 0)
}

func uiRunMessageLoop() {
	var m uiMSG
	for {
		ret, _, _ := uiGetMsg.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if ret == 0 || ret == ^uintptr(0) {
			break
		}
		uiTransMsg.Call(uintptr(unsafe.Pointer(&m)))
		uiDispatchMsg.Call(uintptr(unsafe.Pointer(&m)))
	}
}

func uiInstallWndProc(hwnd windows.Handle, msg uint32, wparam, lparam uintptr) uintptr {
	switch msg {
	case uiMSG_UPDATE:
		uiStatusMu.Lock()
		t := uiStatus
		uiStatusMu.Unlock()
		uiSetStatusText(t)
		return 0
	case uiMSG_PROGR:
		uiApplyProgress(int(wparam))
		return 0
	case uiMSG_QUIT:
		uiPostQuit.Call(0)
		return 0
	case uiWM_DESTROY:
		uiPostQuit.Call(0)
		return 0
	}
	ret, _, _ := uiDefWndProc.Call(uintptr(hwnd), uintptr(msg), wparam, lparam)
	return ret
}
