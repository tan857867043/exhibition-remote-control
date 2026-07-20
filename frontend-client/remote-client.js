class ExhibitionRemoteClient {
    constructor(canvasElement, serverUrl, targetDeviceId, onStats) {
        this.canvas = canvasElement;
        this.ctx = this.canvas.getContext('2d');
        this.serverUrl = serverUrl;
        this.deviceId = targetDeviceId;
        this.onStats = onStats || (() => {});
        this.frameSeq = 0;
        this.lastRendered = 0;
        this.srcW = 0;
        this.srcH = 0;

        this.canvas.width = 1920;
        this.canvas.height = 1080;

        // 全帧分辨率追踪（用于增量块坐标缩放）
        // 初始值用 canvas 默认尺寸，确保即使首帧降采样也能正确计算 scale
        this.maxFullW = this.canvas.width;
        this.maxFullH = this.canvas.height;

        // Debug 开关：设为 true 可在画面上看到增量块的红色边框
        this.debugOverlay = true;

        // 输入状态
        this.mouseDown = false;
        this.lastMouseMoveTime = 0;
        this.mouseMoveThrottle = 30; // ms
        this.keyboardCaptured = false;   // 是否在捕获键盘模式
        this.modifiers = { ctrl: false, alt: false, shift: false, meta: false };

        this.initWebSocket();
        this.initInputBinding();
    }

    // ---- WebSocket ----
    initWebSocket() {
        const wsUrl = this.serverUrl.replace(/^http/, 'ws');
        this.ws = new WebSocket(`${wsUrl}/api/v1/stream?device_id=${this.deviceId}`);
        this.ws.binaryType = 'arraybuffer';
        this.pendingTasks = [];
        this.processing = false;

        this.ws.onmessage = (event) => {
            const buffer = event.data;
            const view = new DataView(buffer);
            const frameType = view.getUint8(0);
            const x = view.getUint16(1);
            const y = view.getUint16(3);
            const w = view.getUint16(5);
            const h = view.getUint16(7);

            const jpegData = new Uint8Array(buffer, 9);

            // 反馈统计
            this.onStats({ type: 'frame', frameType, byteLength: buffer.byteLength });

            const task = {
                frameType, x, y, w, h,
                bitmapPromise: createImageBitmap(new Blob([jpegData], { type: 'image/jpeg' }))
            };
            this.pendingTasks.push(task);
            this.processTasks();
        };
    }

    async processTasks() {
        if (this.processing) return;
        this.processing = true;

        while (this.pendingTasks.length > 0) {
            const task = this.pendingTasks.shift();
            try {
                const bitmap = await task.bitmapPromise;
                
                if (task.frameType === 0x02) {
                    // 全帧：记录最大分辨率（即原始屏幕分辨率）
                    if (task.w > this.maxFullW) this.maxFullW = task.w;
                    if (task.h > this.maxFullH) this.maxFullH = task.h;

                    this.canvas.width = task.w;
                    this.canvas.height = task.h;
                    this.ctx.drawImage(bitmap, 0, 0, task.w, task.h);
                } else {
                    // 增量块
                    const scaleX = this.maxFullW > 0 ? this.canvas.width / this.maxFullW : 1;
                    const scaleY = this.maxFullH > 0 ? this.canvas.height / this.maxFullH : 1;
                    const dx = Math.round(task.x * scaleX);
                    const dy = Math.round(task.y * scaleY);
                    const dw = Math.max(1, Math.round(task.w * scaleX));
                    const dh = Math.max(1, Math.round(task.h * scaleY));

                    this.ctx.drawImage(bitmap, dx, dy, dw, dh);

                    // Debug: 红色矩形框标记增量块位置
                    if (this.debugOverlay) {
                        this.ctx.strokeStyle = 'rgba(255, 0, 0, 0.6)';
                        this.ctx.lineWidth = 1;
                        this.ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);
                    }
                }
                bitmap.close();
            } catch (err) {
                console.error("Bitmap decode error:", err);
            }
        }
        
        this.processing = false;
    }

    // ---- 坐标换算 ----
    screenToRemote(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.maxFullW || this.canvas.width;
        const scaleY = this.maxFullH || this.canvas.height;
        return {
            x: Math.round(((clientX - rect.left) / rect.width) * scaleX),
            y: Math.round(((clientY - rect.top) / rect.height) * scaleY)
        };
    }

    // ---- 发送控制命令 ----
    sendControl(action, extra = {}) {
        const payload = JSON.stringify({
            device_id: this.deviceId,
            action: action,
            ...extra
        });

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(payload);
        } else {
            // 回退到 HTTP 或静默
            fetch(`${this.serverUrl}/api/v1/control`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload
            }).catch(() => {});
        }
    }

    // ---- 输入绑定 ----
    initInputBinding() {
        // === 鼠标事件 ===
        // mousedown → 远程 mouse_down
        this.canvas.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const { x, y } = this.screenToRemote(e.clientX, e.clientY);
            const btn = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
            this.mouseDown = true;
            this.sendControl('mouse_move', { x, y });
            this.sendControl('mouse_down', { button: btn });
            // 激活键盘捕获
            this.captureKeyboard();
        });

        // mouseup → 远程 mouse_up
        this.canvas.addEventListener('mouseup', (e) => {
            e.preventDefault();
            const btn = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
            this.mouseDown = false;
            this.sendControl('mouse_up', { button: btn });
        });

        // mousemove → 远程 mouse_move（拖拽时或频率限制）
        this.mouseMoveThrottle = 16; // 60fps 对应的节流
        this.canvas.addEventListener('mousemove', (e) => {
            if (!this.mouseDown) return;
            const now = Date.now();
            if (now - this.lastMouseMoveTime < this.mouseMoveThrottle) return;
            this.lastMouseMoveTime = now;
            const { x, y } = this.screenToRemote(e.clientX, e.clientY);
            this.sendControl('mouse_move', { x, y });
        });

        // 滚轮
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            // deltaY > 0 向下滚，取反后符合 enigo：正=向上
            const delta = Math.round(-e.deltaY / 40); // 转为行数
            this.sendControl('mouse_wheel', { y: delta });
        }, { passive: false });

        // 禁止右键菜单
        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });

        // === 键盘事件 ===
        document.addEventListener('keydown', (e) => {
            if (!this.keyboardCaptured) return;
            e.preventDefault();
            // 跟踪修饰键状态
            this.updateModifiers(e, true);

            // 先发修饰键
            if (e.ctrlKey && !this._prevCtrl) this.sendControl('key_press', { key: 'Control' });
            if (e.altKey && !this._prevAlt) this.sendControl('key_press', { key: 'Alt' });
            if (e.shiftKey && !this._prevShift) this.sendControl('key_press', { key: 'Shift' });
            if (e.metaKey && !this._prevMeta) this.sendControl('key_press', { key: 'Meta' });

            this._prevCtrl = e.ctrlKey;
            this._prevAlt = e.altKey;
            this._prevShift = e.shiftKey;
            this._prevMeta = e.metaKey;

            // 发实际按键（跳过纯修饰键）
            if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
                this.sendControl('key_press', { key: e.key });
            }
        });

        document.addEventListener('keyup', (e) => {
            if (!this.keyboardCaptured) return;
            e.preventDefault();
            this.updateModifiers(e, false);

            // 发实际按键释放
            if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
                this.sendControl('key_release', { key: e.key });
            }

            // 释放松开的修饰键
            if (!e.ctrlKey && this._prevCtrl) this.sendControl('key_release', { key: 'Control' });
            if (!e.altKey && this._prevAlt) this.sendControl('key_release', { key: 'Alt' });
            if (!e.shiftKey && this._prevShift) this.sendControl('key_release', { key: 'Shift' });
            if (!e.metaKey && this._prevMeta) this.sendControl('key_release', { key: 'Meta' });

            this._prevCtrl = e.ctrlKey;
            this._prevAlt = e.altKey;
            this._prevShift = e.shiftKey;
            this._prevMeta = e.metaKey;
        });
    }

    updateModifiers(e, pressed) {
        // 留作扩展
    }

    captureKeyboard() {
        if (!this.keyboardCaptured) {
            this.keyboardCaptured = true;
            this._prevCtrl = false;
            this._prevAlt = false;
            this._prevShift = false;
            this._prevMeta = false;
            this.onStats({ type: 'keyboard', captured: true });
        }
    }

    releaseKeyboard() {
        if (this.keyboardCaptured) {
            this.keyboardCaptured = false;
            // 释放所有可能还按着的键
            if (this._prevCtrl) this.sendControl('key_release', { key: 'Control' });
            if (this._prevAlt) this.sendControl('key_release', { key: 'Alt' });
            if (this._prevShift) this.sendControl('key_release', { key: 'Shift' });
            if (this._prevMeta) this.sendControl('key_release', { key: 'Meta' });
            this.onStats({ type: 'keyboard', captured: false });
        }
    }
}
