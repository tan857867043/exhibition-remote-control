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

// Cursor Type Map for Native Operating System Cursor Matching
const CURSOR_STYLE_MAP = {
    0: 'default',        // Arrow
    1: 'text',           // I-beam
    2: 'pointer',        // Hand
    3: 'ns-resize',      // Size NS
    4: 'ew-resize',      // Size WE
    5: 'wait',           // Wait / App Starting
    6: 'crosshair',      // Cross
    7: 'move',           // Size All / Move
    8: 'nesw-resize',    // Size NESW
    9: 'se-resize',      // Size NWSE / SE
    255: 'none'          // Hidden / Blank
};

function getVk(e){
    if(CODE_TO_VK[e.code]!==undefined)return CODE_TO_VK[e.code];
    return e.keyCode||e.which||0;
}

class ExhibitionRemoteClient {
    constructor(canvas, serverUrl, deviceId, onStats) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false });
        this.ctx.imageSmoothingEnabled = false;
        this.serverUrl = serverUrl;
        this.deviceId = deviceId;
        this.onStats = onStats;

        // 清空 canvas，防止旧画面残留
        this.ctx.fillStyle = '#0f172a';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        this.offscreenCanvas = document.createElement('canvas');
        this.offscreenCtx = this.offscreenCanvas.getContext('2d', { alpha: false });
        this.offscreenCtx.imageSmoothingEnabled = false;

        this.maxFullW = this.canvas.width || 1920;
        this.maxFullH = this.canvas.height || 1080;

        this.isMouseDown = false;
        this.activeButton = -1;
        this.lastMouseMoveTime = 0;
        this.keyboardCaptured = false;
        this.pressedKeys = {};
        this.currentCursorType = 0;
        this._useImageDecoder = typeof ImageDecoder !== 'undefined';
        this._processingVideo = false;
        this._frameSeq = 0;
        this._rAFId = null;
        this._wheelAccum = 0;
        this._receivedFrames = 0;
        this._renderedFrames = 0;
        this._inputDisabled = false; // 文件管理器等弹窗打开时禁用远程输入，防止穿透
        this._lastFrameTime = Date.now();
        this._freezeCheckTimer = null;

        // File transfer state
        this._fmCallback = null;

        this._downloadState = null;
        this._uploadState = null;

        // Window-level handlers to preserve drag state outside canvas bounds
        this._onMouseMove = (e) => this.sendMouseEvent(e);
        this._onMouseDown = (e) => this.handleMouseDown(e);
        this._onMouseUp = (e) => this.handleMouseUp(e);
        this._onWheel = (e) => this.sendMouseEvent(e);
        this._onKeyDown = (e) => this.sendKeyboardEvent(e);
        this._onKeyUp = (e) => this.sendKeyboardEvent(e);
        this._onContextMenu = (e) => {
            if (this.keyboardCaptured || this.isInsideCanvas(e)) {
                e.preventDefault();
            }
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
            this.setQuality(50);
            this._startFreezeCheck();
        };

        this.ws.onmessage = async (e) => {
            if (typeof e.data === 'string') {
                try {
                    const msg = JSON.parse(e.data);
                    console.log("[WS] Received text message:", msg.action, msg);
                    if (msg.action && (msg.action === 'download' || msg.action === 'upload')) {
                        this._handleFileMessage(msg);
                    } else if (this._fmCallback) {
                        console.log("[WS] Routing to _fmCallback:", msg.action);
                        this._fmCallback(msg);
                    }
                } catch(err) {
                    console.error("[WS] Failed to parse text message:", err, e.data);
                }
                return;
            }
            const buf = new Uint8Array(e.data);

            // 独立光标消息 [0x0A, cursor_type]: 不依赖视频帧，即时更新 CSS cursor
            if (buf.length === 2 && buf[0] === 0x0A) {
                if (this.currentCursorType !== buf[1]) {
                    this.currentCursorType = buf[1];
                    this.updateCursorStyle();
                }
                return;
            }

            if (buf.length >= 4 && buf[0] === 0x01 && buf[1] === 0x00 && buf[2] === 0x00 && this._downloadState) {
                const state = this._downloadState;

                if (state.cancelled) {
                    return;
                }

                const isLast = buf[3] === 0x01;
                const chunkData = buf.slice(4);
                
                state.chunks.push(chunkData);
                state.receivedSize += chunkData.length;
                
                if (state.onProgress && state.totalSize > 0) {
                    const progress = Math.min(100, Math.round((state.receivedSize / state.totalSize) * 100));
                    const elapsed = state.startTime > 0 ? (performance.now() - state.startTime) / 1000 : 0;
                    const speedMBs = elapsed > 0 ? (state.receivedSize / 1024 / 1024) / elapsed : 0;
                    state.onProgress(progress, speedMBs, 'transferring');
                }
                
                if (!isLast && !state.paused) {
                    this.ws.send(JSON.stringify({
                        action: 'download',
                        sub: 'ack',
                        id: state.id,
                    }));
                }
                
                if (isLast) {
                    const combined = new Uint8Array(state.receivedSize);
                    let offset = 0;
                    for (let i = 0; i < state.chunks.length; i++) {
                        combined.set(state.chunks[i], offset);
                        offset += state.chunks[i].length;
                    }
                    if (state.doneResolve) {
                        state.doneResolve(combined.buffer);
                    }
                }
                return;
            }

            this.onStats({ type: 'frame', byteLength: buf.length });
            this._lastFrameTime = Date.now();

            if (this._processingVideo) return;
            this._processingVideo = true;
            try {
                const MIN_HEADER_SIZE = 14;
                let offset = 0;
                const totalSize = buf.length;
                const mySeq = ++this._frameSeq;
                let cursorType = this.currentCursorType;

                while (offset + MIN_HEADER_SIZE <= totalSize) {
                    const frameType = buf[offset];
                    const x = (buf[offset + 1] << 8) | buf[offset + 2];
                    const y = (buf[offset + 3] << 8) | buf[offset + 4];
                    const w = (buf[offset + 5] << 8) | buf[offset + 6];
                    const h = (buf[offset + 7] << 8) | buf[offset + 8];
                    const jpegLen = (buf[offset + 9] << 24) | (buf[offset + 10] << 16) | (buf[offset + 11] << 8) | buf[offset + 12];
                    cursorType = buf[offset + 13];

                    // 帧头中 cursorType 已就绪，立即更新 CSS cursor（不等 JPEG 解码和渲染）
                    if (this.currentCursorType !== cursorType) {
                        this.currentCursorType = cursorType;
                        this.updateCursorStyle();
                    }

                    if (frameType === 0x01) {
                        this.onStats({ type: 'frame', frameType: 0x01, byteLength: 0 });
                    }

                    const regionSize = MIN_HEADER_SIZE + jpegLen;
                    if (offset + regionSize > totalSize) break;

                    if (w === 0 || h === 0 || jpegLen === 0) {
                        offset += regionSize;
                        continue;
                    }

                    const jpegData = buf.slice(offset + MIN_HEADER_SIZE, offset + regionSize);

                    if (frameType === 0x02 || frameType === 0x03 || frameType === 0x04) {
                        this._receivedFrames++;
                        if (w !== this.offscreenCanvas.width || h !== this.offscreenCanvas.height) {
                            this.offscreenCanvas.width = w;
                            this.offscreenCanvas.height = h;
                            this.offscreenCtx.imageSmoothingEnabled = false;
                            this.canvas.width = w;
                            this.canvas.height = h;
                            this.ctx.imageSmoothingEnabled = false;
                            this.maxFullW = w;
                            this.maxFullH = h;
                        }
                    }

                    const bitmap = await this._decodeJpeg(jpegData);
                    if (mySeq !== this._frameSeq) { bitmap.close(); return; }
                    this.offscreenCtx.drawImage(bitmap, x, y, w, h);
                    bitmap.close();
                    offset += regionSize;
                }

                if (mySeq === this._frameSeq) {
                    this._scheduleRender();
                }
            } finally {
                this._processingVideo = false;
            }
        };

        this.ws.onclose = () => {
            console.log("Disconnected from device stream");
            this._stopFreezeCheck();
            if (this._downloadState && this._downloadState.errorReject) {
                this._downloadState.errorReject(new Error('disconnected'));
            }
            if (this._uploadState && this._uploadState.errorReject) {
                this._uploadState.errorReject(new Error('disconnected'));
            }
            this._downloadState = null;
            this._uploadState = null;
        };
    }

    _startFreezeCheck() {
        this._stopFreezeCheck();
        this._lastFrameTime = Date.now();
        this._freezeCheckTimer = setInterval(() => {
            const elapsed = Date.now() - this._lastFrameTime;
            if (elapsed > 15000 && this.onStats) {
                this.onStats({ type: 'freeze', elapsedMs: elapsed });
            }
        }, 1000);
    }

    _stopFreezeCheck() {
        if (this._freezeCheckTimer) {
            clearInterval(this._freezeCheckTimer);
            this._freezeCheckTimer = null;
        }
    }

    destroy() {
        this._stopFreezeCheck();
        if (this._rAFId) cancelAnimationFrame(this._rAFId);
        if (this.ws) {
            try { this.ws.close(); } catch(e) {}
        }
        this.releaseKeyboard();
    }

    getReceivedFrameCount() { return this._receivedFrames; }
    getRenderedFrameCount() { return this._renderedFrames; }
    resetFrameCounters() { this._receivedFrames = 0; this._renderedFrames = 0; }

    _scheduleRender() {
        if (this._rAFId === null) {
            this._rAFId = requestAnimationFrame(() => {
                this._rAFId = null;
                this.ctx.drawImage(this.offscreenCanvas, 0, 0);
                this._renderedFrames++;
            });
        }
    }

    async _decodeJpeg(jpegData) {
        if (this._useImageDecoder) {
            try {
                const decoder = new ImageDecoder({ data: jpegData, type: 'image/jpeg' });
                const result = await decoder.decode();
                return result.image;
            } catch (e) {
                this._useImageDecoder = false;
            }
        }
        return await createImageBitmap(new Blob([jpegData]));
    }

    updateCursorStyle() {
        if (!this.canvas) return;
        const style = CURSOR_STYLE_MAP[this.currentCursorType] || 'default';
        this.canvas.style.cursor = style;
    }

    isInsideCanvas(e) {
        if (!this.canvas) return false;
        const r = this.canvas.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    }

    getCanvasCoordinates(e) {
        const r = this.canvas.getBoundingClientRect();
        const scale = Math.min(r.width / this.canvas.width, r.height / this.canvas.height);
        const imgW = this.canvas.width * scale;
        const imgH = this.canvas.height * scale;
        const offsetX = (r.width - imgW) / 2;
        const offsetY = (r.height - imgH) / 2;
        
        let rx = e.clientX - r.left - offsetX;
        let ry = e.clientY - r.top - offsetY;

        // Clamp values to canvas dimensions during drag operations
        rx = Math.max(0, Math.min(imgW, rx));
        ry = Math.max(0, Math.min(imgH, ry));
        
        const x = Math.round(rx / scale);
        const y = Math.round(ry / scale);
        return { x, y, isWithin: rx >= 0 && ry >= 0 && rx <= imgW && ry <= imgH };
    }

    handleMouseDown(e) {
        if (this._inputDisabled) return;
        if (!this.isInsideCanvas(e)) return;
        this.isMouseDown = true;
        this.activeButton = e.button;
        this.captureKeyboard();
        this.sendMouseEvent(e);
    }

    handleMouseUp(e) {
        if (this._inputDisabled) { this.isMouseDown = false; return; }
        if (this.isMouseDown) {
            this.isMouseDown = false;
            this.sendMouseEvent(e);
            this.activeButton = -1;
        }
    }

    sendMouseEvent(e) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this._inputDisabled) return;
        if (!this.keyboardCaptured && e.type !== 'mousedown' && !this.isMouseDown) return;

        const { x, y, isWithin } = this.getCanvasCoordinates(e);
        if (!isWithin && e.type !== 'mouseup' && e.type !== 'mousemove') return;

        // Web button → Agent mapping: Web(0=Left,1=Middle,2=Right) → Agent(0=Left,1=Right,2=Middle)
        const BTN_MAP = [0, 2, 1];
        const btn = BTN_MAP[e.button] ?? e.button;
        let buf;

        if (e.type === 'mousemove') {
            const now = performance.now();
            // Ultra-responsive mouse movement (~120Hz throughput limit for zero lag)
            if (now - this.lastMouseMoveTime < 8) return;
            this.lastMouseMoveTime = now;
            buf = new Uint8Array([0x01, btn, x & 0xFF, (x >> 8) & 0xFF, y & 0xFF, (y >> 8) & 0xFF]);
        } else if (e.type === 'mousedown') {
            buf = new Uint8Array([0x02, btn, 1, 0, 0, 0]);
        } else if (e.type === 'mouseup') {
            buf = new Uint8Array([0x02, btn, 0, 0, 0, 0]);
        } else if (e.type === 'wheel') {
            e.preventDefault();
            // Accumulate deltas and send notch count when reaching WHEEL_DELTA threshold
            // Works with all mice: Chrome(~100/notch), Firefox(~3), smooth-scroll(~4-16)
            this._wheelAccum += e.deltaY;
            const clicks = Math.trunc(this._wheelAccum / 120);
            if (clicks !== 0) {
                this._wheelAccum -= clicks * 120;
                const d = clicks;
                buf = new Uint8Array([0x03, 0, d & 0xFF, (d >> 8) & 0xFF, 0, 0]);
            } else {
                return;
            }
        } else {
            return;
        }
        
        this.ws.send(buf.buffer);
    }

    sendKeyboardEvent(e) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this._inputDisabled) return;
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

        // Send each key event immediately (no batching)
        const keyAction = e.type === 'keydown' ? 0 : 1;
        this.ws.send(JSON.stringify({ action: 'key', vk: vk, down: keyAction === 0 }));
    }

    setQuality(qualityValue) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ action: 'quality', value: qualityValue }));
        }
    }

    _handleFileMessage(msg) {
        switch(msg.action) {
            case 'file_error':
                if (this._downloadState && this._downloadState.errorReject) {
                    this._downloadState.errorReject(new Error(msg.error || 'download_error'));
                }
                if (this._uploadState && this._uploadState.errorReject) {
                    this._uploadState.errorReject(new Error(msg.error || 'upload_error'));
                }
                break;
            case 'download':
                if (msg.sub === 'start') {
                    if (this._downloadState) {
                        this._downloadState.totalSize = msg.size || 0;
                        if (this._downloadState.readyResolve) {
                            this._downloadState.readyResolve();
                        }
                    }
                }
                break;
            case 'upload':
                if (msg.sub === 'start' && this._uploadState) {
                    if (this._uploadState.readyResolve) {
                        this._uploadState.readyResolve();
                    }
                } else if (msg.sub === 'done' && this._uploadState) {
                    if (this._uploadState.doneResolve) {
                        this._uploadState.doneResolve();
                    }
                } else if (msg.sub === 'error' && this._uploadState) {
                    if (this._uploadState.errorReject) {
                        this._uploadState.errorReject(new Error(msg.error || 'upload_error'));
                    }
                }
                break;
        }
    }

    setFileManagerCallback(cb) {
        this._fmCallback = cb;
    }

    pauseTransfer() {
        if (this._uploadState) {
            this._uploadState.paused = true;
        }
        if (this._downloadState) {
            this._downloadState.paused = true;
        }
    }

    resumeTransfer() {
        if (this._uploadState) {
            this._uploadState.paused = false;
            if (this._uploadState.pauseResolve) {
                const resolve = this._uploadState.pauseResolve;
                this._uploadState.pauseResolve = null;
                resolve();
            }
        }
        if (this._downloadState) {
            this._downloadState.paused = false;
            if (this._downloadState.pauseResolve) {
                const resolve = this._downloadState.pauseResolve;
                this._downloadState.pauseResolve = null;
                resolve();
            }
        }
    }

    cancelTransfer() {
        if (this._uploadState) {
            this._uploadState.cancelled = true;
            this._uploadState.paused = false;
            if (this._uploadState.pauseResolve) {
                const resolve = this._uploadState.pauseResolve;
                this._uploadState.pauseResolve = null;
                resolve();
            }
            if (this._uploadState.errorReject) {
                this._uploadState.errorReject(new Error('cancelled'));
            }
        }
        if (this._downloadState) {
            this._downloadState.cancelled = true;
            this._downloadState.paused = false;
            if (this._downloadState.pauseResolve) {
                const resolve = this._downloadState.pauseResolve;
                this._downloadState.pauseResolve = null;
                resolve();
            }
            if (this._downloadState.errorReject) {
                this._downloadState.errorReject(new Error('cancelled'));
            }
        }
    }

    async sendFile(file, targetDir, options, onProgress) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket not connected');
        }

        const CHUNK_SIZE = 512 * 1024; // 512KB per chunk for faster transfer
        const uploadId = 'ul_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

        const state = {
            id: uploadId,
            file: file,
            totalSize: file.size,
            sentSize: 0,
            readyResolve: null,
            doneResolve: null,
            errorReject: null,
            onProgress: onProgress,
            paused: false,
            cancelled: false,
            pauseResolve: null,
        };
        this._uploadState = state;

        try {
            await new Promise((resolve, reject) => {
                state.readyResolve = resolve;
                state.errorReject = reject;
                const timeout = setTimeout(() => reject(new Error('upload start timeout')), 30000);
                state.errorReject = (err) => {
                    clearTimeout(timeout);
                    reject(err);
                };
                this.ws.send(JSON.stringify({
                    action: 'upload',
                    sub: 'start',
                    path: targetDir,
                    name: file.name,
                    size: file.size,
                    id: uploadId,
                }));
            });

            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
            const startTime = performance.now();

            for (let i = 0; i < totalChunks; i++) {
                if (state.cancelled) {
                    throw new Error('cancelled');
                }
                while (state.paused) {
                    await new Promise((resolve) => { state.pauseResolve = resolve; });
                }
                if (state.cancelled) {
                    throw new Error('cancelled');
                }

                const begin = i * CHUNK_SIZE;
                const end = Math.min(begin + CHUNK_SIZE, file.size);
                const chunkData = await file.slice(begin, end).arrayBuffer();

                const header = new Uint8Array([0x09]);
                const combined = new Uint8Array(1 + chunkData.byteLength);
                combined.set(header);
                combined.set(new Uint8Array(chunkData), 1);
                
                // Wait if the buffer is full (e.g., > 10MB) to apply backpressure
                while (this.ws.bufferedAmount > 10 * 1024 * 1024) {
                    await new Promise(r => setTimeout(r, 10));
                }
                
                this.ws.send(combined.buffer);

                state.sentSize += chunkData.byteLength;

                if (onProgress && (i % 8 === 0 || i === totalChunks - 1)) {
                    const progress = Math.round((state.sentSize / state.totalSize) * 100);
                    const elapsed = (performance.now() - startTime) / 1000;
                    const speedMBs = elapsed > 0 ? (state.sentSize / 1024 / 1024) / elapsed : 0;
                    onProgress(progress, speedMBs, 'transferring');
                }
            }

            while (this.ws.bufferedAmount > 0) {
                await new Promise(r => setTimeout(r, 5));
            }

            this.ws.send(JSON.stringify({
                action: 'upload',
                sub: 'done',
                id: uploadId,
            }));

            await new Promise((resolve, reject) => {
                state.doneResolve = resolve;
                state.errorReject = reject;
                setTimeout(() => reject(new Error('upload done timeout')), 60000);
            });

            if (onProgress) onProgress(100, 0, 'completed');
        } finally {
            this._uploadState = null;
        }
    }

    async downloadFile(remotePath, onProgress) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket not connected');
        }

        const downloadId = 'dl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        const fileName = remotePath.split('\\').pop() || remotePath.split('/').pop() || 'download';
        
        const state = {
            id: downloadId,
            totalSize: 0,
            receivedSize: 0,
            chunks: [],
            windowSize: 64, // Increased window size for faster downloads
            onProgress: onProgress,
            readyResolve: null,
            doneResolve: null,
            errorReject: null,
            cancelled: false,
            paused: false,
            pauseResolve: null,
            startTime: 0,
        };
        this._downloadState = state;

        try {
            await new Promise((resolve, reject) => {
                state.readyResolve = resolve;
                state.errorReject = reject;
                const timeout = setTimeout(() => reject(new Error('download start timeout')), 30000);
                state.errorReject = (err) => {
                    clearTimeout(timeout);
                    reject(err);
                };
                this.ws.send(JSON.stringify({
                    action: 'download',
                    sub: 'start',
                    path: remotePath,
                    id: downloadId,
                }));
            });

            this.ws.send(JSON.stringify({
                action: 'download',
                sub: 'startack',
                id: downloadId,
                ack: state.windowSize,
            }));
            state.startTime = performance.now();

            const result = await new Promise((resolve, reject) => {
                state.doneResolve = resolve;
                state.errorReject = reject;
                setTimeout(() => reject(new Error('download timeout')), 300000);
            });

            if (onProgress) onProgress(100, 0, 'completed');

            const blob = new Blob([result]);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = fileName;
            a.click();
            URL.revokeObjectURL(a.href);
        } finally {
            this._downloadState = null;
        }
    }

    initInputBinding() {
        window.addEventListener('mousemove', this._onMouseMove, { passive: true });
        window.addEventListener('mousedown', this._onMouseDown, { passive: true });
        window.addEventListener('mouseup', this._onMouseUp, { passive: true });
        this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
        window.addEventListener('contextmenu', this._onContextMenu);
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
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

    disableInput() {
        this._inputDisabled = true;
    }

    enableInput() {
        this._inputDisabled = false;
    }

    destroy() {
        if (this._rAFId !== null) {
            cancelAnimationFrame(this._rAFId);
            this._rAFId = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        window.removeEventListener('mousemove', this._onMouseMove);
        window.removeEventListener('mousedown', this._onMouseDown);
        window.removeEventListener('mouseup', this._onMouseUp);
        if (this.canvas) {
            this.canvas.removeEventListener('wheel', this._onWheel);
        }
        window.removeEventListener('contextmenu', this._onContextMenu);
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
    }
}

export default ExhibitionRemoteClient;
