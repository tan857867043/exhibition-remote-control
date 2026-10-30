// 轻量文件传输 WebSocket 客户端
// 仅处理文件上传协议，不引入画布、输入、帧处理等远程控制逻辑
// 复用现有的 upload text指令 + 0x09 二进制分块协议

class FileTransferClient {
  public ws: WebSocket | null = null;
  private serverUrl: string;
  private deviceId: string;
  private _uploadState: any = null;
  private _downloadState: any = null;
  private _closeResolve: (() => void) | null = null;
  private _openResolve: (() => void) | null = null;
  private _openReject: ((err: Error) => void) | null = null;
  private _openTimer: ReturnType<typeof setTimeout> | null = null;
  private _checkDirPending: { path: string; resolve: (exists: boolean) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(serverUrl: string, deviceId: string) {
    this.serverUrl = serverUrl;
    this.deviceId = deviceId;
    this.connect();
  }

  private connect(): void {
    const wsProtocol = this.serverUrl.startsWith('https') ? 'wss' : 'ws';
    const host = this.serverUrl.replace(/^https?:\/\//, '');
    const wsUrl = `${wsProtocol}://${host}/api/v1/stream?device_id=${this.deviceId}&kind=files`;

    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this._openTimer = setTimeout(() => {
      if (this._openReject) {
        this._openReject(new Error('WebSocket connect timeout'));
        this._openReject = null;
      }
    }, 15000);

    this.ws.onopen = () => {
      if (this._openTimer) { clearTimeout(this._openTimer); this._openTimer = null; }
      if (this._openResolve) { this._openResolve(); this._openResolve = null; }
    };

    this.ws.onerror = () => {
      if (this._openTimer) { clearTimeout(this._openTimer); this._openTimer = null; }
      if (this._openReject) { this._openReject(new Error('WebSocket error')); this._openReject = null; }
    };

    this.ws.onclose = () => {
      if (this._openTimer) { clearTimeout(this._openTimer); this._openTimer = null; }
      if (this._openReject) { this._openReject(new Error('WebSocket closed before open')); this._openReject = null; }
      if (this._closeResolve) { this._closeResolve(); this._closeResolve = null; }
    };

    this.ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data);
          this._handleFileMessage(msg);
        } catch (_) { /* ignore parse errors */ }
      } else {
        // Binary message: 仅下载分块（0xF1）需要处理，视频帧与本通道无关
        const buf = new Uint8Array(e.data as ArrayBuffer);
        if (buf.length >= 4 && buf[0] === 0xF1 && this._downloadState) {
          this._handleDownloadChunk(buf);
        }
      }
    };
  }

  /** Wait for WebSocket open with timeout */
  waitOpen(timeoutMs: number = 15000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      this._openResolve = resolve;
      this._openReject = reject;
    });
  }

  /** Wait for WebSocket close */
  waitClose(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this._closeResolve = resolve;
    });
  }

  /** 上传文件到远程 Agent */
  async sendFile(
    file: File,
    targetDir: string,
    options: { overwrite?: string },
    onProgress?: (progress: number, speedMBs: number, status: string) => void
  ): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const CHUNK_SIZE = 512 * 1024;
    const uploadId = 'ul_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

    const state = {
      id: uploadId,
      file: file,
      totalSize: file.size,
      sentSize: 0,
      readyResolve: null as (() => void) | null,
      doneResolve: null as (() => void) | null,
      errorReject: null as ((err: Error) => void) | null,
      onProgress: onProgress,
      paused: false,
      cancelled: false,
      pauseResolve: null as (() => void) | null,
    };
    this._uploadState = state;

    try {
      // Phase 1: Send start command and wait for agent acknowledgment
      await new Promise<void>((resolve, reject) => {
        state.readyResolve = resolve;
        const timeout = setTimeout(() => {
          state.errorReject = null;
          reject(new Error('upload start timeout'));
        }, 30000);
        state.errorReject = (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        };
        this.ws!.send(JSON.stringify({
          action: 'upload',
          sub: 'start',
          path: targetDir,
          name: file.name,
          size: file.size,
          id: uploadId,
          overwrite: options.overwrite || 'overwrite',
        }));
      });

      // Phase 2: Send chunks
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const startTime = performance.now();

      for (let i = 0; i < totalChunks; i++) {
        if (state.cancelled) throw new Error('cancelled');
        while (state.paused) {
          await new Promise<void>((resolve) => { state.pauseResolve = resolve; });
        }
        if (state.cancelled) throw new Error('cancelled');

        const begin = i * CHUNK_SIZE;
        const end = Math.min(begin + CHUNK_SIZE, file.size);
        const chunkData = await file.slice(begin, end).arrayBuffer();

        const header = new Uint8Array([0x09]);
        const combined = new Uint8Array(1 + chunkData.byteLength);
        combined.set(header);
        combined.set(new Uint8Array(chunkData), 1);

        while (this.ws!.bufferedAmount > 10 * 1024 * 1024) {
          await new Promise(r => setTimeout(r, 10));
        }

        this.ws!.send(combined.buffer);
        state.sentSize += chunkData.byteLength;

        if (onProgress && (i % 8 === 0 || i === totalChunks - 1)) {
          const progress = Math.round((state.sentSize / state.totalSize) * 100);
          const elapsed = (performance.now() - startTime) / 1000;
          const speedMBs = elapsed > 0 ? (state.sentSize / 1024 / 1024) / elapsed : 0;
          onProgress(progress, speedMBs, 'transferring');
        }
      }

      // Wait for buffer to drain
      while (this.ws!.bufferedAmount > 0) {
        await new Promise(r => setTimeout(r, 5));
      }

      // Phase 3: Send done and wait for agent acknowledgment
      this.ws!.send(JSON.stringify({
        action: 'upload',
        sub: 'done',
        id: uploadId,
      }));

      await new Promise<void>((resolve, reject) => {
        state.doneResolve = resolve;
        state.errorReject = reject;
        setTimeout(() => reject(new Error('upload done timeout')), 60000);
      });

      if (onProgress) onProgress(100, 0, 'completed');
    } finally {
      this._uploadState = null;
    }
  }

  /** 探测远端目录是否存在（上传前用于提示"是否创建目录"） */
  checkDirExists(path: string, timeoutMs: number = 8000): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      this._checkDirPending = {
        path,
        resolve,
        timer: setTimeout(() => {
          if (this._checkDirPending) this._checkDirPending = null;
          resolve(false); // 超时视为不存在（保守处理，由 Agent 上传兜底创建）
        }, timeoutMs),
      };
      this.ws!.send(JSON.stringify({ action: 'check_dir', path }));
    });
  }

  /** 创建远端目录（幂等，已存在则忽略） */
  createDir(path: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: 'create_dir', path }));
    }
  }

  private _handleFileMessage(msg: any): void {
    switch (msg.action) {
      case 'check_dir':
        if (this._checkDirPending && this._checkDirPending.path === msg.path) {
          clearTimeout(this._checkDirPending.timer);
          const resolve = this._checkDirPending.resolve;
          this._checkDirPending = null;
          resolve(msg.exists === true);
        }
        break;
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

  private _handleDownloadChunk(_buf: Uint8Array): void {
    // Download is not needed for batch upload, but keep the protocol handling
    // for future use if download gets added to the batch transfer page
  }

  /** 关闭连接 */
  destroy(): void {
    if (this._uploadState) {
      this._uploadState.cancelled = true;
    }
    if (this._downloadState) {
      this._downloadState.cancelled = true;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onopen = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
  }
}

export default FileTransferClient;
