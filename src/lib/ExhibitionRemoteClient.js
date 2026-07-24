// ============ VK Code Mapping (e.code → Windows VK) ============
const CODE_TO_VK = {
    // Letters
    KeyA:0x41,KeyB:0x42,KeyC:0x43,KeyD:0x44,KeyE:0x45,KeyF:0x46,KeyG:0x47,KeyH:0x48,
    KeyI:0x49,KeyJ:0x4A,KeyK:0x4B,KeyL:0x4C,KeyM:0x4D,KeyN:0x4E,KeyO:0x4F,KeyP:0x50,
    KeyQ:0x51,KeyR:0x52,KeyS:0x53,KeyT:0x54,KeyU:0x55,KeyV:0x56,KeyW:0x57,KeyX:0x58,
    KeyY:0x59,KeyZ:0x5A,
    // Numbers
    Digit0:0x30,Digit1:0x31,Digit2:0x32,Digit3:0x33,Digit4:0x34,
    Digit5:0x35,Digit6:0x36,Digit7:0x37,Digit8:0x38,Digit9:0x39,
    // Numpad
    Numpad0:0x60,Numpad1:0x61,Numpad2:0x62,Numpad3:0x63,Numpad4:0x64,
    Numpad5:0x65,Numpad6:0x66,Numpad7:0x67,Numpad8:0x68,Numpad9:0x69,
    NumpadMultiply:0x6A,NumpadAdd:0x6B,NumpadSubtract:0x6D,NumpadDecimal:0x6E,NumpadDivide:0x6F,
    // Function keys
    F1:0x70,F2:0x71,F3:0x72,F4:0x73,F5:0x74,F6:0x75,
    F7:0x76,F8:0x77,F9:0x78,F10:0x79,F11:0x7A,F12:0x7B,
    // Navigation
    ArrowUp:0x26,ArrowDown:0x28,ArrowLeft:0x25,ArrowRight:0x27,
    Home:0x24,End:0x23,PageUp:0x21,PageDown:0x22,Insert:0x2D,Delete:0x2E,
    // Modifiers
    ShiftLeft:0xA0,ShiftRight:0xA1,ControlLeft:0xA2,ControlRight:0xA3,
    AltLeft:0xA4,AltRight:0xA5,MetaLeft:0x5B,MetaRight:0x5C,
    // Special
    Space:0x20,Enter:0x0D,Tab:0x09,Escape:0x1B,Backspace:0x08,
    CapsLock:0x14,NumLock:0x90,ScrollLock:0x91,PrintScreen:0x2C,Pause:0x13,
    // Symbols
    Minus:0xBD,Equal:0xBB,BracketLeft:0xDB,BracketRight:0xDD,Backslash:0xDC,
    Semicolon:0xBA,Quote:0xDE,Comma:0xBC,Period:0xBE,Slash:0xBF,Backquote:0xC0,
    // Numpad Enter
    NumpadEnter:0x0D,
};
const MODIFIER_CODES = new Set(['ShiftLeft','ShiftRight','ControlLeft','ControlRight','AltLeft','AltRight','MetaLeft','MetaRight']);

function getVk(e){
    if(CODE_TO_VK[e.code]!==undefined)return CODE_TO_VK[e.code];
    return e.keyCode||e.which||0;
}

class ExhibitionRemoteClient {
    constructor(canvas, serverUrl, deviceId, onStats) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false });
        this.serverUrl = serverUrl;
        this.deviceId = deviceId;
        this.onStats = onStats;

        this.offscreenCanvas = document.createElement('canvas');
        this.offscreenCtx = this.offscreenCanvas.getContext('2d', { alpha: false });

        this.maxFullW = this.canvas.width;
        this.maxFullH = this.canvas.height;

        this.mouseDown = false;
        this.lastMouseMoveTime = 0;
        this.keyboardCaptured = false;
        this.pressedKeys = {};
        this.keyBatch = [];
        this.keyBatchTimer = null;

        this.cursorX = -1;
        this.cursorY = -1;
        this.cursorType = 0;
        this.pendingRender = null;
        this.rAFId = null;
        this.frameSeq = 0;        // 帧序号，防止 async 竞态
        this.receivedFrames = 0;  // 收到的帧计数
        this.renderedFrames = 0;  // 实际渲染的帧计数（用于真实 FPS）
        this._processingVideo = false; // 视频帧处理中锁，防止并发解码浪费

        this.canvas.style.cursor = 'none';

        this._onMouseMove = (e) => this.sendMouseEvent(e);
        this._onMouseDown = (e) => this.sendMouseEvent(e);
        this._onMouseUp = (e) => this.sendMouseEvent(e);
        this._onWheel = (e) => this.sendMouseEvent(e);
        this._onKeyDown = (e) => this.sendKeyboardEvent(e);
        this._onKeyUp = (e) => this.sendKeyboardEvent(e);
        this._onContextMenu = (e) => {
            if (this.keyboardCaptured) e.preventDefault();
        };

        this.initConnection();
        this.initInputBinding();
    }

    initConnection() {
        const wsProtocol = this.serverUrl.startsWith('https') ? 'wss' : 'ws';
        const host = this.serverUrl.replace(/^https?:\/\//, '');
        const wsUrl = `${wsProtocol}://${host}/api/v1/stream?device_id=${this.deviceId}`;
        
        this.ws = new WebSocket(wsUrl);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            console.log("Connected to device stream");
            // Set default quality immediately
            this.setQuality(50);
        };

        this.ws.onmessage = async (e) => {
            if (typeof e.data === 'string') return;
            const buf = new Uint8Array(e.data);
            this.onStats({ type: 'frame', byteLength: buf.length });
            this.receivedFrames++;
            const totalSize = buf.length;
            if (totalSize < 1) return;

            const frameType = buf[0];

            if (frameType === 0x07) {
                // === 光标位置 ===
                // [0x07][cursor_x:2 BE][cursor_y:2 BE]
                if (totalSize < 5) return;
                this.cursorX = (buf[1] << 8) | buf[2];
                this.cursorY = (buf[3] << 8) | buf[4];
            } else if (frameType === 0x08) {
                // === 光标形状 ===
                // [0x08][cursor_type:1][png_len:2 BE][png_data...]
                if (totalSize < 4) return;
                this.cursorType = buf[1];
            } else if (this._processingVideo) {
                // 视频帧(0x01~0x04)处理中锁：上一帧解码尚未完成，直接丢弃当前帧
                // 避免多个 async handler 并发导致 Go server 通道积压 + 50% 丢弃
                return;
            } else if (frameType === 0x01) {
                // === 批量增量块消息 (v2) ===
                this._processingVideo = true;
                try {
                this.onStats({ type: 'frame', frameType: 0x01, byteLength: 0 });
                if (totalSize < 3) return;
                const numBlocks = (buf[1] << 8) | buf[2];
                if (numBlocks === 0) return;

                // 逐块解析 + 渲染到离屏 canvas
                let offset = 3;
                const BLOCK_HEADER = 11;
                const jpegBatch = [];

                for (let i = 0; i < numBlocks && offset + BLOCK_HEADER <= totalSize; i++) {
                    const bx = (buf[offset] << 8) | buf[offset+1];
                    const by = (buf[offset+2] << 8) | buf[offset+3];
                    const bw = (buf[offset+4] << 8) | buf[offset+5];
                    const bh = (buf[offset+6] << 8) | buf[offset+7];
                    const encoding = buf[offset+8];
                    const dataLen = (buf[offset+9] << 8) | buf[offset+10];
                    offset += BLOCK_HEADER;
                    if (dataLen === 0 || offset + dataLen > totalSize) break;

                    if (encoding === 1) {
                        const rawData = new Uint8Array(buf.slice(offset, offset + dataLen));
                        const clampedArray = new Uint8ClampedArray(rawData.buffer, rawData.byteOffset, dataLen);
                        const imageData = new ImageData(clampedArray, bw, bh);
                        this.offscreenCtx.putImageData(imageData, bx, by);
                    } else {
                        jpegBatch.push({ x: bx, y: by, w: bw, h: bh, data: buf.slice(offset, offset + dataLen) });
                    }
                    offset += dataLen;
                }

                // JPEG 块分批解码（每批 4 个并发）
                const batchMySeq = ++this.frameSeq;
                const BATCH_SIZE = 4;
                for (let i = 0; i < jpegBatch.length; i += BATCH_SIZE) {
                    const batch = jpegBatch.slice(i, i + BATCH_SIZE);
                    const results = await Promise.all(batch.map(async (b) => {
                        const bitmap = await createImageBitmap(new Blob([b.data]));
                        return { bitmap, x: b.x, y: b.y, w: b.w, h: b.h };
                    }));
                    if (batchMySeq !== this.frameSeq) {
                        for (const {bitmap} of results) bitmap.close();
                        break;
                    }
                    for (const {bitmap, x, y, w, h} of results) {
                        this.offscreenCtx.drawImage(bitmap, x, y, w, h);
                        bitmap.close();
                    }
                }
                if (batchMySeq === this.frameSeq) {
                    this.renderedFrames++;
                }
                } finally {
                    this._processingVideo = false;
                }
                // 通过 rAF 渲染队列拷贝到显示 canvas
                this.pendingRender = true;
                if (this.rAFId === null) {
                    this.rAFId = requestAnimationFrame(() => this._renderLoop());
                }
            } else {
                // === 全帧消息 ===
                this._processingVideo = true;
                try {
                const HEADER_SIZE = 9;
                if (totalSize < HEADER_SIZE) return;
                const x = (buf[1] << 8) | buf[2];
                const y = (buf[3] << 8) | buf[4];
                const w = (buf[5] << 8) | buf[6];
                const h = (buf[7] << 8) | buf[8];
                if (w === 0 || h === 0) return;
                const jpegData = buf.slice(HEADER_SIZE);
                if (jpegData.length === 0) return;

                if (w !== this.offscreenCanvas.width || h !== this.offscreenCanvas.height) {
                    this.offscreenCanvas.width = w;
                    this.offscreenCanvas.height = h;
                    this.canvas.width = w;
                    this.canvas.height = h;
                    this.maxFullW = w;
                    this.maxFullH = h;
                }

                try {
                    const mySeq = ++this.frameSeq;
                    const bitmap = await createImageBitmap(new Blob([jpegData]));
                    if (mySeq !== this.frameSeq) { bitmap.close(); return; } // 过期帧，丢弃
                    this.offscreenCtx.drawImage(bitmap, 0, 0, w, h);
                    bitmap.close();
                    this.renderedFrames++;
                    // 通过 rAF 渲染队列拷贝到显示 canvas
                    this.pendingRender = true;
                    if (this.rAFId === null) {
                        this.rAFId = requestAnimationFrame(() => this._renderLoop());
                    }
                } catch (err) {
                    console.error("Decode error:", err);
                }
                } finally {
                    this._processingVideo = false;
                }
            }
        };

        this.ws.onclose = () => {
            console.log("Disconnected from device stream");
        };
    }

    sendMouseEvent(e) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (!this.keyboardCaptured && e.type !== 'mousedown') return;

        if (e.type === 'mousedown') {
            this.captureKeyboard();
        }

        const r = this.canvas.getBoundingClientRect();
        const scale = Math.min(r.width / this.canvas.width, r.height / this.canvas.height);
        const imgW = this.canvas.width * scale;
        const imgH = this.canvas.height * scale;
        const offsetX = (r.width - imgW) / 2;
        const offsetY = (r.height - imgH) / 2;
        const rx = e.clientX - r.left - offsetX;
        const ry = e.clientY - r.top - offsetY;
        
        if (rx < 0 || ry < 0 || rx > imgW || ry > imgH) return;
        
        const x = Math.round(rx / scale);
        const y = Math.round(ry / scale);
        const btn = e.button; 
        
        let buf;
        if (e.type === 'mousemove') {
            const now = Date.now();
            if (now - this.lastMouseMoveTime < 16) return;
            this.lastMouseMoveTime = now;
            buf = new Uint8Array([0x01, btn, x & 0xFF, (x >> 8) & 0xFF, y & 0xFF, (y >> 8) & 0xFF]);
        } else if (e.type === 'mousedown') {
            buf = new Uint8Array([0x02, btn, 1, 0, 0, 0]);
        } else if (e.type === 'mouseup') {
            buf = new Uint8Array([0x02, btn, 0, 0, 0, 0]);
        } else if (e.type === 'wheel') {
            e.preventDefault();
            const d = Math.round(e.deltaY);
            buf = new Uint8Array([0x03, 0, d & 0xFF, (d >> 8) & 0xFF, 0, 0]);
        } else {
            return;
        }
        
        this.ws.send(buf.buffer);
    }

    sendKeyboardEvent(e) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const vk = getVk(e);
        if (!vk) return;

        if (e.type === 'keydown' && e.ctrlKey && e.altKey && vk === 0x2E) {
            e.preventDefault();
            this.ws.send(new Uint8Array([0x05, 10, 0, 0, 0, 0]).buffer);
            return;
        }

        if (!this.keyboardCaptured) return;

        if (e.type === 'keydown') {
            this.pressedKeys[e.code] = vk;
            if (e.repeat) return;
            e.preventDefault();
        } else if (e.type === 'keyup') {
            delete this.pressedKeys[e.code];
            e.preventDefault();
        } else {
            return;
        }

        if (MODIFIER_CODES.has(e.code)) {
            const action = e.type === 'keydown' ? 0 : 1;
            const buf = new Uint8Array([0x04, 1, action, vk & 0xFF, (vk >> 8) & 0xFF, 0, 0]);
            this.ws.send(buf.buffer);
            return;
        }

        const action = e.type === 'keydown' ? 0 : 1;
        this.keyBatch.push(action, vk & 0xFF, (vk >> 8) & 0xFF);
        
        if (!this.keyBatchTimer) {
            this.keyBatchTimer = setTimeout(() => {
                this.keyBatchTimer = null;
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
                const buf = new Uint8Array(2 + this.keyBatch.length);
                buf[0] = 0x04;
                buf[1] = this.keyBatch.length / 3;
                for (let i = 0; i < this.keyBatch.length; i++) buf[2 + i] = this.keyBatch[i];
                this.ws.send(buf.buffer);
                this.keyBatch = [];
            }, 2);
        }
    }

    setQuality(qualityValue) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ action: 'quality', value: qualityValue }));
        }
    }

    getRenderedFrameCount() {
        return this.renderedFrames;
    }
    getReceivedFrameCount() {
        return this.receivedFrames;
    }
    resetFrameCount() {
        this.renderedFrames = 0;
        this.receivedFrames = 0;
    }

    initInputBinding() {
        document.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('mousedown', this._onMouseDown);
        document.addEventListener('mouseup', this._onMouseUp);
        this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
        document.addEventListener('contextmenu', this._onContextMenu);
        document.addEventListener('keydown', this._onKeyDown);
        document.addEventListener('keyup', this._onKeyUp);
    }

    captureKeyboard() {
        if (!this.keyboardCaptured) {
            this.keyboardCaptured = true;
            this.onStats({ type: 'keyboard', captured: true });
        }
    }

    releaseKeyboard() {
        if (this.keyboardCaptured) {
            this.keyboardCaptured = false;
            for (let code of Object.keys(this.pressedKeys)) {
                let vk = this.pressedKeys[code];
                const buf = new Uint8Array([0x04, 1, 1, vk & 0xFF, (vk >> 8) & 0xFF, 0, 0]);
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(buf.buffer);
                }
            }
            this.pressedKeys = {};
            this.onStats({ type: 'keyboard', captured: false });
        }
    }

    _renderLoop() {
        if (this.pendingRender) {
            this.pendingRender = false;
            this.ctx.drawImage(this.offscreenCanvas, 0, 0);
            // 绘制光标叠加层
            if (this.cursorX >= 0) {
                this.ctx.beginPath();
                this.ctx.arc(this.cursorX, this.cursorY, 4, 0, 2 * Math.PI);
                this.ctx.fillStyle = 'rgba(255,255,255,0.8)';
                this.ctx.fill();
                this.ctx.strokeStyle = 'rgba(0,0,0,0.8)';
                this.ctx.lineWidth = 1.5;
                this.ctx.stroke();
            }
        }
        this.rAFId = requestAnimationFrame(() => this._renderLoop());
    }

    destroy() {
        if (this.rAFId !== null) {
            cancelAnimationFrame(this.rAFId);
            this.rAFId = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        document.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('mousedown', this._onMouseDown);
        document.removeEventListener('mouseup', this._onMouseUp);
        this.canvas.removeEventListener('wheel', this._onWheel);
        document.removeEventListener('contextmenu', this._onContextMenu);
        document.removeEventListener('keydown', this._onKeyDown);
        document.removeEventListener('keyup', this._onKeyUp);
    }
}
export default ExhibitionRemoteClient;
