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

            const MIN_HEADER_SIZE = 14;
            let offset = 0;
            const tasks = [];
            let hasFullFrame = false;
            let cursorType = 0;
            const totalSize = buf.length;

            while(offset + MIN_HEADER_SIZE <= totalSize) {
                const frameType = buf[offset];
                const x = (buf[offset+1] << 8) | buf[offset+2];
                const y = (buf[offset+3] << 8) | buf[offset+4];
                const w = (buf[offset+5] << 8) | buf[offset+6];
                const h = (buf[offset+7] << 8) | buf[offset+8];
                const jpegLen = (buf[offset+9] << 24) | (buf[offset+10] << 16) | (buf[offset+11] << 8) | buf[offset+12];
                cursorType = buf[offset+13];
                
                if (frameType === 0x01) {
                    this.onStats({ type: 'frame', frameType: 0x01, byteLength: 0 });
                }

                const regionSize = MIN_HEADER_SIZE + jpegLen;
                if(offset + regionSize > totalSize) break;
                
                if(w === 0 || h === 0 || jpegLen === 0){
                    offset += regionSize;
                    continue;
                }

                const jpegData = buf.slice(offset + MIN_HEADER_SIZE, offset + regionSize);
                
                if (frameType === 0x02 || frameType === 0x04) {
                    hasFullFrame = true;
                    if(w !== this.offscreenCanvas.width || h !== this.offscreenCanvas.height) {
                        this.offscreenCanvas.width = w;
                        this.offscreenCanvas.height = h;
                        this.canvas.width = w;
                        this.canvas.height = h;
                        this.maxFullW = w;
                        this.maxFullH = h;
                    }
                }
                
                tasks.push(createImageBitmap(new Blob([jpegData])).then(bitmap => ({bitmap, x, y, w, h, frameType})));
                offset += regionSize;
            }

            Promise.all(tasks).then(results => {
                for (const {bitmap, x, y, w, h, frameType} of results) {
                    if (frameType === 0x02 || frameType === 0x04) {
                        this.offscreenCtx.drawImage(bitmap, 0, 0);
                    } else {
                        this.offscreenCtx.drawImage(bitmap, x, y);
                        this.ctx.drawImage(bitmap, x, y);
                    }
                    bitmap.close();
                }
                if (hasFullFrame) {
                    this.ctx.drawImage(this.offscreenCanvas, 0, 0);
                }
                const cursorMap = ['default','text','pointer','n-resize','e-resize','wait','crosshair','move','ne-resize','se-resize'];
                this.canvas.style.cursor = cursorType === 255 ? 'none' : (cursorMap[cursorType] || 'default');
            }).catch(() => {});
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

    destroy() {
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
