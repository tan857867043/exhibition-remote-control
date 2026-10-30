import socket
import subprocess
import sys
import os
import threading
import time
import wx
import wx.adv

# Windows 注册表支持
if sys.platform == 'win32':
    import winreg

# === 配置 ===
PORT = 9527
DELAY = 5

class ShutdownService:
    def __init__(self):
        self.running = True
        self.start_time = time.time()
        self.ip = self._get_ip()

    def _get_ip(self):
        """获取本机IP"""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("8.8.8.8", 80))
                return s.getsockname()[0]
        except:
            return "127.0.0.1"

    def _cmd(self, args):
        """执行系统命令 (隐藏窗口)"""
        if sys.platform == 'win32':
            subprocess.run(args, shell=True, creationflags=subprocess.CREATE_NO_WINDOW)
        else:
            subprocess.run(args, shell=True)

    def start(self):
        """启动TCP监听"""
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            server.bind(('0.0.0.0', PORT))
            server.listen(5)
            server.settimeout(1.0) # 允许循环检查退出状态
            
            while self.running:
                try:
                    client, _ = server.accept()
                    threading.Thread(target=self._handle, args=(client,), daemon=True).start()
                except socket.timeout:
                    continue
                except:
                    break
        finally:
            server.close()

    def _handle(self, client):
        """处理客户端请求"""
        try:
            client.settimeout(5)
            data = client.recv(1024).decode().strip().upper()
            resp = "ERROR"
            
            if data == 'SHUTDOWN':
                cmd = ['shutdown', '/s', '/t', str(DELAY)] if sys.platform == 'win32' else ['shutdown', '-h', f'+{DELAY//60 or 1}']
                self._cmd(cmd)
                resp = "OK:Shutdown"
            elif data == 'REBOOT':
                cmd = ['shutdown', '/r', '/t', str(DELAY)] if sys.platform == 'win32' else ['shutdown', '-r', f'+{DELAY//60 or 1}']
                self._cmd(cmd)
                resp = "OK:Reboot"
            elif data == 'CANCEL':
                cmd = ['shutdown', '/a'] if sys.platform == 'win32' else ['shutdown', '-c']
                self._cmd(cmd)
                resp = "OK:Cancel"
            elif data == 'PING':
                resp = "PONG"
            elif data == 'STATUS':
                uptime = int(time.time() - self.start_time)
                resp = f"OK:Running|Uptime:{uptime}s"

            client.send(resp.encode())
        except:
            pass
        finally:
            client.close()

    def set_autostart(self, enable):
        """设置开机自启 (仅Windows)"""
        if sys.platform != 'win32': return False
        key_path = r"Software\Microsoft\Windows\CurrentVersion\Run"
        try:
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_WRITE)
            if enable:
                winreg.SetValueEx(key, "ShutdownService", 0, winreg.REG_SZ, sys.executable)
            else:
                try: winreg.DeleteValue(key, "ShutdownService")
                except: pass
            winreg.CloseKey(key)
            return True
        except: return False

    def is_autostart(self):
        if sys.platform != 'win32': return False
        try:
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_READ)
            val, _ = winreg.QueryValueEx(key, "ShutdownService")
            return val == sys.executable
        except: return False

class TaskBarIcon(wx.adv.TaskBarIcon):
    def __init__(self, frame):
        super().__init__()
        self.frame = frame
        self.Bind(wx.adv.EVT_TASKBAR_LEFT_DOWN, self.on_click)

    def CreatePopupMenu(self):
        menu = wx.Menu()
        menu.Append(1, "显示")
        menu.Append(2, "退出")
        self.Bind(wx.EVT_MENU, lambda e: self.frame.Show(), id=1)
        self.Bind(wx.EVT_MENU, lambda e: self.frame.Close(), id=2)
        return menu

    def on_click(self, event):
        if self.frame.IsShown(): self.frame.Hide()
        else: self.frame.Show()

class MainFrame(wx.Frame):
    def __init__(self, service):
        super().__init__(None, title="局域网关机服务", size=(350, 240), style=wx.DEFAULT_FRAME_STYLE & ~wx.MAXIMIZE_BOX)
        self.service = service
        self.Center()
        
        # UI构建
        panel = wx.Panel(self)
        vbox = wx.BoxSizer(wx.VERTICAL)
        
        # 简单的大字体状态
        self.st_status = wx.StaticText(panel, label="运行中")
        self.st_status.SetFont(wx.Font(16, wx.DEFAULT, wx.NORMAL, wx.BOLD))
        self.st_status.SetForegroundColour("#008800")
        vbox.Add(self.st_status, 0, wx.ALIGN_CENTER | wx.TOP, 20)
        
        # 信息显示
        info_sizer = wx.BoxSizer(wx.VERTICAL)
        self.st_ip = wx.StaticText(panel, label=f"IP地址: {service.ip}")
        self.st_port = wx.StaticText(panel, label=f"监听端口: {PORT}")
        self.st_time = wx.StaticText(panel, label="运行时间: 0s")
        
        info_sizer.Add(self.st_ip, 0, wx.BOTTOM, 8)
        info_sizer.Add(self.st_port, 0, wx.BOTTOM, 8)
        info_sizer.Add(self.st_time, 0, wx.BOTTOM, 8)
        vbox.Add(info_sizer, 0, wx.ALIGN_CENTER | wx.TOP | wx.BOTTOM, 20)
        
        # 自启动开关
        self.cb_start = wx.CheckBox(panel, label="开机自动启动")
        self.cb_start.SetValue(service.is_autostart())
        self.cb_start.Bind(wx.EVT_CHECKBOX, self.on_check)
        vbox.Add(self.cb_start, 0, wx.ALIGN_CENTER)
        
        panel.SetSizer(vbox)
        
        # 托盘与图标
        icon_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icon.ico')
        if os.path.exists(icon_path):
            icon = wx.Icon(icon_path, wx.BITMAP_TYPE_ICO)
        else:
            icon = wx.ArtProvider.GetIcon(wx.ART_GO_HOME, wx.ART_OTHER, (32,32))
        self.SetIcon(icon)
        self.tray = TaskBarIcon(self)
        self.tray.SetIcon(icon, "关机服务")
        
        # 计时器刷新界面
        self.timer = wx.Timer(self)
        self.Bind(wx.EVT_TIMER, self.on_timer, self.timer)
        self.timer.Start(1000)
        
        self.Bind(wx.EVT_CLOSE, self.on_close)
        self.Bind(wx.EVT_ICONIZE, self.on_iconize)
        
        # 后台启动服务
        threading.Thread(target=service.start, daemon=True).start()
        
        # 启动即隐藏
        self.Hide()

    def on_iconize(self, event):
        """拦截最小化事件，隐藏到托盘"""
        if event.IsIconized():
            self.Hide()

    def on_timer(self, event):
        seconds = int(time.time() - self.service.start_time)
        self.st_time.SetLabel(f"运行时间: {seconds}s")

    def on_check(self, event):
        self.service.set_autostart(self.cb_start.GetValue())

    def on_close(self, event):
        dlg = wx.MessageDialog(self, 
            "确定要退出关机服务吗？", 
            "退出确认", 
            wx.YES_NO | wx.NO_DEFAULT | wx.ICON_QUESTION)
        if dlg.ShowModal() == wx.ID_YES:
            self.service.running = False
            self.tray.RemoveIcon()
            self.Destroy()
            sys.exit()
        dlg.Destroy()

if __name__ == '__main__':
    app = wx.App()
    # 确保单例运行
    if wx.SingleInstanceChecker("SimpleShutdownSvc").IsAnotherRunning():
        sys.exit()
    MainFrame(ShutdownService())
    app.MainLoop()