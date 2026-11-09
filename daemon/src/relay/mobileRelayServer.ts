import * as crypto from 'crypto';
import * as http from 'http';
import { Duplex } from 'stream';
import {
  OrchestrationRunResult,
  OrchestratorEngine,
  TaskStateChangeEvent,
} from '../orchestrator/orchestratorEngine';
import {
  ApprovalDecisionPayload,
  ApprovalRequestPayload,
  EngineMode,
  MegaXConfig,
  TerminalStreamEvent,
} from '../types/contracts';

export interface FcmNotificationPayload {
  title: string;
  body: string;
  data: {
    approvalId: string;
    taskId: string;
    trigger: string;
    affectedFiles: string;
    actions: string; // JSON array: ["APPROVE", "ROLLBACK"]
  };
}

export type FcmPushSender = (
  notification: FcmNotificationPayload
) => Promise<void> | void;

export type RelayOutboundMessage =
  | { type: 'TERMINAL_STREAM'; payload: TerminalStreamEvent }
  | { type: 'STATE_CHANGE'; payload: TaskStateChangeEvent }
  | { type: 'APPROVAL_REQUIRED'; payload: ApprovalRequestPayload }
  | { type: 'ORCHESTRATION_RESULT'; payload: OrchestrationRunResult }
  | { type: 'CONFIG_UPDATED'; payload: MegaXConfig };

export type RelayInboundMessage =
  | {
      type: 'PROMPT_SUBMIT';
      taskId: string;
      prompt: string;
      contextFiles?: string[];
    }
  | {
      type: 'APPROVAL_DECISION';
      payload: ApprovalDecisionPayload;
    }
  | {
      type: 'SET_ENGINE_MODE';
      engineMode: EngineMode;
    };

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Bi-Directional Relay Server (WebSocket + HTTP REST + FCM Interactive Push Hook)
 * connecting the Flutter Mobile Controller to the Local Core Daemon.
 */
export class MobileRelayServer {
  private readonly engine: OrchestratorEngine;
  private readonly fcmSender?: FcmPushSender;
  private readonly relaySecretToken?: string;
  private server?: http.Server;
  private readonly clients = new Set<Duplex>();
  private readonly pendingApprovals = new Map<
    string,
    (decision: ApprovalDecisionPayload) => void
  >();

  constructor(
    engine: OrchestratorEngine,
    fcmSender?: FcmPushSender,
    relaySecretToken = process.env.MEGAX_RELAY_TOKEN
  ) {
    this.engine = engine;
    this.fcmSender = fcmSender;
    this.relaySecretToken = relaySecretToken;

    // Wire engine telemetry and security gate into the relay
    this.engine.getVerificationRunner().setStreamListener((evt) => {
      this.broadcast({ type: 'TERMINAL_STREAM', payload: evt });
    });

    this.engine.setStateChangeListener((evt) => {
      this.broadcast({ type: 'STATE_CHANGE', payload: evt });
    });

    this.engine.getSecurityGate().setApprovalHandler((req) => {
      return this.handleApprovalRequest(req);
    });
  }

  /**
   * Dispatches an interactive FCM push notification and broadcasts APPROVAL_REQUIRED
   * over WebSockets, pausing orchestration until the mobile user responds.
   */
  private async handleApprovalRequest(
    request: ApprovalRequestPayload
  ): Promise<ApprovalDecisionPayload> {
    this.broadcast({ type: 'APPROVAL_REQUIRED', payload: request });

    if (this.fcmSender) {
      await this.fcmSender({
        title: `⚠️ MeGa X Security Gate: ${request.trigger}`,
        body: request.summary,
        data: {
          approvalId: request.approvalId,
          taskId: request.taskId,
          trigger: request.trigger,
          affectedFiles: JSON.stringify(request.affectedFiles),
          actions: JSON.stringify(['APPROVE', 'ROLLBACK']),
        },
      });
    }

    return new Promise<ApprovalDecisionPayload>((resolve) => {
      this.pendingApprovals.set(request.approvalId, resolve);
    });
  }

  /**
   * Resolves a pending approval gate from either WebSocket or HTTP FCM webhook.
   */
  public submitApprovalDecision(decision: ApprovalDecisionPayload): boolean {
    const resolver = this.pendingApprovals.get(decision.approvalId);
    if (!resolver) {
      return false;
    }
    this.pendingApprovals.delete(decision.approvalId);
    resolver(decision);
    return true;
  }

  /**
   * Starts the HTTP + WebSocket Relay Server on the specified port.
   */
  public async start(port = 0, host = '127.0.0.1'): Promise<number> {
    this.server = http.createServer((req, res) =>
      this.handleHttpRequest(req, res)
    );

    this.server.on('upgrade', (req, socket) => {
      this.handleWebSocketUpgrade(req, socket);
    });

    return new Promise<number>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(port, host, () => {
        const addr = this.server?.address();
        const boundPort =
          addr && typeof addr === 'object' ? addr.port : port;
        resolve(boundPort);
      });
    });
  }

  /**
   * Gracefully stops the Relay Server and closes active mobile connections.
   */
  public async stop(): Promise<void> {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    if (!this.server) {
      return;
    }

    return new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
  }

  /**
   * Broadcasts a typed event to all connected Flutter WebSocket clients.
   */
  public broadcast(message: RelayOutboundMessage): void {
    const frame = MobileRelayServer.encodeWsTextFrame(JSON.stringify(message));
    for (const socket of this.clients) {
      if (!socket.destroyed) {
        socket.write(frame);
      }
    }
  }

  private isAuthorizedRequest(req: http.IncomingMessage): boolean {
    if (!this.relaySecretToken) {
      return true;
    }

    const authHeader = req.headers['authorization'];
    let providedToken: string | undefined;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      providedToken = authHeader.slice('Bearer '.length).trim();
    } else if (req.url) {
      const parsedUrl = new URL(req.url, 'http://localhost');
      providedToken = parsedUrl.searchParams.get('token') ?? undefined;
    }

    if (!providedToken) {
      return false;
    }

    const expectedBuf = Buffer.from(this.relaySecretToken, 'utf-8');
    const actualBuf = Buffer.from(providedToken, 'utf-8');
    if (expectedBuf.length !== actualBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  }

  private handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization'
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const cleanPath = req.url ? req.url.split('?')[0] : '/';

    if (req.method === 'GET' && (cleanPath === '/' || cleanPath === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(MobileRelayServer.renderWebSteeringWheelHtml());
      return;
    }

    if (!this.isAuthorizedRequest(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'Unauthorized: Valid MeGa X relay token required.',
        })
      );
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ONLINE',
          connectedClients: this.clients.size,
          pendingApprovals: Array.from(this.pendingApprovals.keys()),
        })
      );
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/history') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          history: this.engine.getAuditStore().readAll(),
        })
      );
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.engine.getConfig()));
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/config') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { engineMode: EngineMode };
          const updated = this.engine.setEngineMode(parsed.engineMode);
          this.broadcast({ type: 'CONFIG_UPDATED', payload: updated });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(updated));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : 'Invalid request',
            })
          );
        }
      });
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/merge') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as {
            taskBranch: string;
            targetBranch?: string;
            deleteAfterMerge?: boolean;
          };
          const mergeCommitHash = this.engine
            .getGitManager()
            .mergeTaskBranch(
              parsed.taskBranch,
              parsed.targetBranch ?? 'main',
              parsed.deleteAfterMerge ?? true
            );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ merged: true, mergeCommitHash }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : 'Merge failed',
            })
          );
        }
      });
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/approval') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const decision = JSON.parse(body) as ApprovalDecisionPayload;
          const resolved = this.submitApprovalDecision(decision);
          res.writeHead(resolved ? 200 : 404, {
            'Content-Type': 'application/json',
          });
          res.end(JSON.stringify({ resolved }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : 'Invalid JSON',
            })
          );
        }
      });
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/prompt') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as {
            taskId: string;
            prompt: string;
            contextFiles?: string[];
          };
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: true, taskId: parsed.taskId }));

          void this.engine
            .runFeaturePrompt(
              parsed.taskId,
              parsed.prompt,
              parsed.contextFiles ?? []
            )
            .then((result) => {
              this.broadcast({
                type: 'ORCHESTRATION_RESULT',
                payload: result,
              });
            });
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : 'Invalid JSON',
            })
          );
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }

  private handleWebSocketUpgrade(
    req: http.IncomingMessage,
    socket: Duplex
  ): void {
    if (!this.isAuthorizedRequest(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key || typeof key !== 'string') {
      socket.destroy();
      return;
    }

    const acceptKey = crypto
      .createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '\r\n',
    ];

    socket.write(headers.join('\r\n'));
    this.clients.add(socket);

    socket.on('data', (buffer: Buffer) => {
      const text = MobileRelayServer.decodeWsTextFrame(buffer);
      if (!text) {
        return;
      }
      try {
        const msg = JSON.parse(text) as RelayInboundMessage;
        this.handleInboundWsMessage(msg);
      } catch {
        // Ignore malformed frames
      }
    });

    socket.on('close', () => {
      this.clients.delete(socket);
    });
    socket.on('error', () => {
      this.clients.delete(socket);
    });
  }

  private handleInboundWsMessage(msg: RelayInboundMessage): void {
    if (msg.type === 'APPROVAL_DECISION') {
      this.submitApprovalDecision(msg.payload);
      return;
    }

    if (msg.type === 'SET_ENGINE_MODE') {
      const updated = this.engine.setEngineMode(msg.engineMode);
      this.broadcast({ type: 'CONFIG_UPDATED', payload: updated });
      return;
    }

    if (msg.type === 'PROMPT_SUBMIT') {
      void this.engine
        .runFeaturePrompt(msg.taskId, msg.prompt, msg.contextFiles ?? [])
        .then((result) => {
          this.broadcast({ type: 'ORCHESTRATION_RESULT', payload: result });
        });
    }
  }

  /**
   * Encodes a UTF-8 string into an RFC-6455 unmasked WebSocket text frame.
   */
  public static encodeWsTextFrame(text: string): Buffer {
    const payload = Buffer.from(text, 'utf-8');
    const length = payload.length;

    if (length < 126) {
      const header = Buffer.from([0x81, length]);
      return Buffer.concat([header, payload]);
    }

    if (length < 65536) {
      const header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
      return Buffer.concat([header, payload]);
    }

    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
    return Buffer.concat([header, payload]);
  }

  /**
   * Decodes an RFC-6455 WebSocket text frame (masked or unmasked) into a UTF-8 string.
   */
  public static decodeWsTextFrame(buffer: Buffer): string | null {
    if (buffer.length < 2) {
      return null;
    }

    const opcode = buffer[0] & 0x0f;
    if (opcode !== 0x01) {
      return null; // Only handle text frames
    }

    const isMasked = (buffer[1] & 0x80) !== 0;
    let payloadLength = buffer[1] & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (buffer.length < 4) return null;
      payloadLength = buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLength === 127) {
      if (buffer.length < 10) return null;
      payloadLength = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }

    let maskKey: Buffer | null = null;
    if (isMasked) {
      if (buffer.length < offset + 4) return null;
      maskKey = buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buffer.length < offset + payloadLength) {
      return null;
    }

    const payload = Buffer.from(
      buffer.subarray(offset, offset + payloadLength)
    );
    if (isMasked && maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }

    return payload.toString('utf-8');
  }

  /**
   * Built-in Mobile/Web Steering Wheel Dashboard served at GET /
   */
  public static renderWebSteeringWheelHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MeGa X • Mobile Steering Wheel</title>
  <style>
    :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --accent: #58a6ff; --green: #3fb950; --red: #f85149; --text: #c9d1d9; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); padding: 16px; display: flex; flex-direction: column; height: 100vh; gap: 12px; }
    header { display: flex; justify-content: space-between; align-items: center; background: var(--card); padding: 12px 16px; border-radius: 8px; border: 1px solid var(--border); }
    .badge { padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; background: #21262d; color: var(--accent); }
    #approval-card { display: none; background: #3d1a1a; border: 1px solid var(--red); padding: 12px; border-radius: 8px; }
    #terminal { flex: 1; background: #010409; border: 1px solid var(--border); border-radius: 8px; padding: 12px; overflow-y: auto; font-family: monospace; font-size: 13px; white-space: pre-wrap; }
    .prompt-bar { display: flex; gap: 8px; }
    input { flex: 1; background: var(--card); border: 1px solid var(--border); color: var(--text); padding: 10px 12px; border-radius: 6px; }
    button { background: var(--accent); color: #000; font-weight: 600; border: none; padding: 10px 16px; border-radius: 6px; cursor: pointer; }
    button.danger { background: var(--red); color: #fff; }
  </style>
</head>
<body>
  <header>
    <strong>🚀 MeGa X • Mobile Steering Wheel</strong>
    <span class="badge" id="state-badge">CONNECTING...</span>
  </header>
  <div id="approval-card">
    <div id="approval-text" style="margin-bottom:8px;font-weight:600;"></div>
    <button onclick="sendDecision(true)">APPROVE</button>
    <button class="danger" onclick="sendDecision(false)">REJECT & ROLLBACK</button>
  </div>
  <div id="terminal">Waiting for live Daemon telemetry...\\n</div>
  <div class="prompt-bar">
    <input id="prompt-input" placeholder="Enter high-level feature prompt for MeGa X..." />
    <button onclick="submitPrompt()">Dispatch</button>
  </div>
  <script>
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    const term = document.getElementById('terminal');
    const badge = document.getElementById('state-badge');
    let pendingApproval = null;
    ws.onopen = () => { badge.textContent = 'IDLE (CONNECTED)'; };
    ws.onclose = () => { badge.textContent = 'DISCONNECTED'; };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'TERMINAL_STREAM') {
        term.textContent += msg.payload.data;
        term.scrollTop = term.scrollHeight;
      } else if (msg.type === 'STATE_CHANGE') {
        badge.textContent = msg.payload.state;
        term.textContent += '[STATE -> ' + msg.payload.state + '] ' + msg.payload.message + '\\n';
      } else if (msg.type === 'APPROVAL_REQUIRED') {
        pendingApproval = msg.payload;
        document.getElementById('approval-text').textContent = '⚠️ ' + msg.payload.trigger + ': ' + msg.payload.summary;
        document.getElementById('approval-card').style.display = 'block';
      }
    };
    function submitPrompt() {
      const input = document.getElementById('prompt-input');
      if (!input.value.trim()) return;
      ws.send(JSON.stringify({ type: 'PROMPT_SUBMIT', taskId: 'task_' + Date.now(), prompt: input.value.trim() }));
      input.value = '';
    }
    function sendDecision(approved) {
      if (!pendingApproval) return;
      ws.send(JSON.stringify({ type: 'APPROVAL_DECISION', payload: { approvalId: pendingApproval.approvalId, taskId: pendingApproval.taskId, approved } }));
      document.getElementById('approval-card').style.display = 'none';
      pendingApproval = null;
    }
  </script>
</body>
</html>`;
  }
}

