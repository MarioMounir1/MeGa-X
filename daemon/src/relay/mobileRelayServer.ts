import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import { Duplex } from 'stream';
import { validateMegaXConfig } from '../config/configLoader';
import { getEnvDiagnostics } from '../config/envConfig';
import {
  OrchestrationRunResult,
  OrchestratorEngine,
  TaskStateChangeEvent,
} from '../orchestrator/orchestratorEngine';
import { TaskQueueManager } from '../orchestrator/taskQueue';
import { TelemetryMetricsCollector } from '../storage/metricsCollector';
import {
  ApprovalDecisionPayload,
  ApprovalRequestPayload,
  ApprovalTrigger,
  EngineMode,
  FileDiff,
  MegaXConfig,
  TerminalStreamEvent,
} from '../types/contracts';
import { TerminalStreamThrottler } from './streamThrottler';
import { TunnelInspector } from './tunnelInspector';
import { BenchmarkRunner } from '../benchmark/benchmarkRunner';
import { ReleaseNotesGenerator } from '../git/releaseNotes';
import {
  NetworkHealthMonitor,
  NetworkHealthSnapshot,
  NetworkTransitionEvent,
} from './networkWatchdog';

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
  | { type: 'CONFIG_UPDATED'; payload: MegaXConfig }
  | { type: 'NETWORK_TRANSITION'; payload: NetworkTransitionEvent };

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
    }
  | {
      type: 'ABORT_TASK';
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
    {
      request: ApprovalRequestPayload;
      resolve: (decision: ApprovalDecisionPayload) => void;
    }
  >();
  private readonly streamThrottler: TerminalStreamThrottler;
  private readonly taskQueue: TaskQueueManager;
  private readonly networkMonitor: NetworkHealthMonitor;
  private readonly fcmHistory: Array<
    FcmNotificationPayload & { dispatchedAt: string }
  > = [];

  constructor(
    engine: OrchestratorEngine,
    fcmSender?: FcmPushSender,
    relaySecretToken = process.env.MEGAX_RELAY_TOKEN
  ) {
    this.engine = engine;
    this.fcmSender = fcmSender;
    this.relaySecretToken = relaySecretToken;
    this.networkMonitor = new NetworkHealthMonitor(4040, {
      listener: (evt) => {
        this.broadcast({ type: 'NETWORK_TRANSITION', payload: evt });
      },
    });
    this.streamThrottler = new TerminalStreamThrottler((evt) => {
      this.broadcast({ type: 'TERMINAL_STREAM', payload: evt });
    });
    this.taskQueue = new TaskQueueManager(this.engine, (result) => {
      this.broadcast({ type: 'ORCHESTRATION_RESULT', payload: result });
    });

    // Wire engine telemetry and security gate into the relay
    this.engine.getVerificationRunner().setStreamListener((evt) => {
      this.streamThrottler.push(evt);
    });

    this.engine.setStateChangeListener((evt) => {
      this.broadcast({ type: 'STATE_CHANGE', payload: evt });
    });

    this.engine.getSecurityGate().setApprovalHandler((req) => {
      return this.handleApprovalRequest(req);
    });
  }

  /**
   * Records an FCM notification in the bounded relay log and invokes fcmSender if configured.
   */
  public async dispatchFcmNotification(
    notification: FcmNotificationPayload
  ): Promise<FcmNotificationPayload & { dispatchedAt: string }> {
    const entry = {
      ...notification,
      dispatchedAt: new Date().toISOString(),
    };
    this.fcmHistory.push(entry);
    if (this.fcmHistory.length > 50) {
      this.fcmHistory.shift();
    }
    if (this.fcmSender) {
      await this.fcmSender(notification);
    }
    return entry;
  }

  /**
   * Dispatches an interactive FCM push notification and broadcasts APPROVAL_REQUIRED
   * over WebSockets, pausing orchestration until the mobile user responds.
   */
  private async handleApprovalRequest(
    request: ApprovalRequestPayload
  ): Promise<ApprovalDecisionPayload> {
    this.broadcast({ type: 'APPROVAL_REQUIRED', payload: request });

    await this.dispatchFcmNotification({
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

    return new Promise<ApprovalDecisionPayload>((resolve) => {
      this.pendingApprovals.set(request.approvalId, {
        request,
        resolve,
      });
    });
  }

  /**
   * Returns all currently waiting ApprovalRequestPayloads so reconnecting mobile clients
   * can inspect and resolve pending security gates.
   */
  public getPendingApprovalPayloads(): ApprovalRequestPayload[] {
    return Array.from(this.pendingApprovals.values()).map((entry) => ({
      ...entry.request,
      affectedFiles: [...entry.request.affectedFiles],
    }));
  }

  /**
   * Resolves a pending approval gate from either WebSocket or HTTP FCM webhook.
   */
  public submitApprovalDecision(decision: ApprovalDecisionPayload): boolean {
    const entry = this.pendingApprovals.get(decision.approvalId);
    if (!entry) {
      return false;
    }
    this.pendingApprovals.delete(decision.approvalId);
    entry.resolve(decision);
    return true;
  }

  public getNetworkMonitor(): NetworkHealthMonitor {
    return this.networkMonitor;
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

    if (req.method === 'GET' && cleanPath === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
      res.end(
        JSON.stringify({
          name: 'MeGa X Steering Wheel',
          short_name: 'MeGa X',
          description: 'Mobile Steering Wheel for Autonomous AI Multi-Agent Orchestrator',
          start_url: '/',
          display: 'standalone',
          background_color: '#0d1117',
          theme_color: '#0d1117',
          icons: [
            {
              src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚀</text></svg>",
              sizes: '192x192 512x512',
              type: 'image/svg+xml',
            },
          ],
        })
      );
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
      const cfg = this.engine.getConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ONLINE',
          projectName: cfg.projectName,
          engineMode: cfg.engineMode,
          connectedClients: this.clients.size,
          pendingApprovals: Array.from(this.pendingApprovals.keys()),
          lastStateEvent: this.engine.getLastStateEvent(),
          uptimeSeconds: Math.floor(process.uptime()),
        })
      );
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/diagnostics') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getEnvDiagnostics()));
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/pairing') {
      const addr = this.server?.address();
      const activePort = addr && typeof addr === 'object' ? addr.port : 4040;
      const pairing = TunnelInspector.getPairingInfo(
        activePort,
        Boolean(this.relaySecretToken)
      );
      const qrPayload = TunnelInspector.generatePairingQrPayload(
        pairing,
        this.relaySecretToken
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ...pairing,
          qrPayload,
        })
      );
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/history') {
      const parsedUrl = new URL(req.url ?? '/api/history', 'http://localhost');
      const rawStatus = parsedUrl.searchParams.get('status')?.toUpperCase();
      const status =
        rawStatus === 'SUCCESS' || rawStatus === 'FAILED'
          ? rawStatus
          : undefined;
      const rawLimit = parsedUrl.searchParams.get('limit');
      const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
      const taskId = parsedUrl.searchParams.get('taskId') ?? undefined;

      const history = this.engine.getAuditStore().queryHistory({
        status,
        limit,
        taskId,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          history,
          totalCount: history.length,
        })
      );
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/history/clear') {
      const clearedCount = this.engine.getAuditStore().clearHistory();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          clearedCount,
        })
      );
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/history/export') {
      const parsedUrl = new URL(
        req.url ?? '/api/history/export',
        'http://localhost'
      );
      const rawFormat = (parsedUrl.searchParams.get('format') ?? 'json').toLowerCase();
      const format = rawFormat === 'markdown' ? 'markdown' : 'json';
      const exported = this.engine.getAuditStore().exportHistory(format);

      if (format === 'markdown') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        res.end(exported);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(exported);
      }
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/metrics') {
      const parsedUrl = new URL(req.url ?? '/api/metrics', 'http://localhost');
      const rawMode = parsedUrl.searchParams.get('mode')?.toUpperCase();
      const engineMode =
        rawMode === 'SINGLE_AGENT' || rawMode === 'MULTI_AGENT'
          ? rawMode
          : undefined;
      const rawLimit = parsedUrl.searchParams.get('limit');
      const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;

      const collector = new TelemetryMetricsCollector(
        this.engine.getAuditStore()
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(collector.getMetricsSummary({ engineMode, limit }))
      );
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/logs') {
      const parsedUrl = new URL(req.url ?? '/api/logs', 'http://localhost');
      const rawStream = parsedUrl.searchParams.get('stream')?.toLowerCase();
      const stream =
        rawStream === 'stdout' ||
        rawStream === 'stderr' ||
        rawStream === 'system'
          ? rawStream
          : undefined;
      const taskId = parsedUrl.searchParams.get('taskId') ?? undefined;
      const rawLimit = parsedUrl.searchParams.get('limit');
      const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;

      const logs = this.streamThrottler.queryLogs({
        stream,
        taskId,
        limit,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          logs,
          totalCount: logs.length,
        })
      );
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/logs/clear') {
      const clearedCount = this.streamThrottler.clearBuffer();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          clearedCount,
        })
      );
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/queue') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          queue: this.taskQueue.getQueueSnapshot(),
        })
      );
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/queue/cancel') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { taskId?: string };
          const targetId = (parsed.taskId ?? '').trim();
          if (!targetId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'taskId is required' }));
            return;
          }
          const cancelled = this.taskQueue.cancelQueuedTask(targetId);
          res.writeHead(cancelled ? 200 : 404, {
            'Content-Type': 'application/json',
          });
          res.end(
            JSON.stringify({
              cancelled,
              taskId: targetId,
            })
          );
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

    if (req.method === 'POST' && cleanPath === '/api/queue/clear') {
      const clearedCount = this.taskQueue.clearFinishedTasks();
      const remainingCount = this.taskQueue.getQueueSnapshot().length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          clearedCount,
          remainingCount,
        })
      );
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/diff') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(this.engine.getGitManager().getWorkingTreeDiff())
      );
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/branches') {
      const git = this.engine.getGitManager();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          currentBranch: git.isGitRepository()
            ? git.getCurrentBranch()
            : 'no-git',
          taskBranches: git.listTaskBranches(),
        })
      );
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/branches/diff') {
      const parsedUrl = new URL(
        req.url ?? '/api/branches/diff',
        'http://localhost'
      );
      const taskBranch = (parsedUrl.searchParams.get('branch') ?? '').trim();
      const baseBranch = (parsedUrl.searchParams.get('base') ?? 'main').trim();
      if (!taskBranch) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: 'Query parameter "branch" is required' })
        );
        return;
      }
      try {
        const unifiedDiff = this.engine
          .getGitManager()
          .getBranchDiff(taskBranch, baseBranch);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            taskBranch,
            baseBranch,
            unifiedDiff,
          })
        );
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error:
              err instanceof Error ? err.message : 'Failed to diff task branch',
          })
        );
      }
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/branches/delete') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as {
            taskBranch?: string;
            fallbackBranch?: string;
          };
          const result = this.engine
            .getGitManager()
            .deleteTaskBranch(
              parsed.taskBranch ?? '',
              parsed.fallbackBranch ?? 'main'
            );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              deleted: true,
              ...result,
            })
          );
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error:
                err instanceof Error ? err.message : 'Branch deletion failed',
            })
          );
        }
      });
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/branches/squash') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as {
            taskBranch?: string;
            baseBranch?: string;
            commitMessage?: string;
          };
          const result = this.engine
            .getGitManager()
            .squashTaskBranchCommits(
              parsed.taskBranch ?? '',
              parsed.baseBranch ?? 'main',
              parsed.commitMessage
            );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              squashed: true,
              ...result,
            })
          );
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error:
                err instanceof Error
                  ? err.message
                  : 'Failed to squash branch commits',
            })
          );
        }
      });
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/commits') {
      const git = this.engine.getGitManager();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          commits: git.getRecentCommits(10),
        })
      );
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/tags') {
      const git = this.engine.getGitManager();
      const tags = git.listReleaseTags();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          tags,
          totalCount: tags.length,
        })
      );
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/tags') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { tag?: string; message?: string };
          const result = this.engine
            .getGitManager()
            .createReleaseTag(parsed.tag ?? '', parsed.message);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : 'Tag creation failed',
            })
          );
        }
      });
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/tags/delete') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { tag?: string };
          const result = this.engine
            .getGitManager()
            .deleteReleaseTag(parsed.tag ?? '');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : 'Tag deletion failed',
            })
          );
        }
      });
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/release/notes') {
      const parsedUrl = new URL(
        req.url ?? '/api/release/notes',
        'http://localhost'
      );
      const version = parsedUrl.searchParams.get('version') ?? 'v1.0.0';
      const rawLimit = parsedUrl.searchParams.get('limit');
      const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 50;
      const format = (parsedUrl.searchParams.get('format') ?? 'markdown').toLowerCase();

      const generator = new ReleaseNotesGenerator(this.engine.getGitManager());
      if (format === 'json') {
        const categorized = generator.categorizeCommits(limit);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ version, ...categorized }));
      } else {
        const markdown = generator.generateMarkdown({ version, limit });
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        res.end(markdown);
      }
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/stash') {
      const git = this.engine.getGitManager();
      const stashes = git.listStashes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          stashes,
          totalCount: stashes.length,
        })
      );
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/stash/push') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed =
            body.trim().length > 0
              ? (JSON.parse(body) as { label?: string })
              : {};
          const git = this.engine.getGitManager();
          const stashed = git.stashUncommittedChanges(
            parsed.label ?? 'megax-mobile-stash'
          );
          const stashes = git.listStashes();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              stashed,
              stashes,
            })
          );
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : 'Git stash push failed',
            })
          );
        }
      });
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/stash/pop') {
      try {
        const git = this.engine.getGitManager();
        git.popLastStash();
        const stashes = git.listStashes();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            popped: true,
            stashes,
          })
        );
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : 'Git stash pop failed',
          })
        );
      }
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/files') {
      const parsedUrl = new URL(req.url ?? '/api/files', 'http://localhost');
      const query = parsedUrl.searchParams.get('query') ?? undefined;
      const files = this.engine
        .getWorkspaceScanner()
        .listWorkspaceFileEntries(query);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          files,
          totalCount: files.length,
        })
      );
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/file') {
      const parsedUrl = new URL(req.url ?? '/api/file', 'http://localhost');
      const relativePath = (parsedUrl.searchParams.get('path') ?? '').trim();
      if (!relativePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Query parameter "path" is required' }));
        return;
      }

      const protectedViolations = this.engine
        .getSecurityGate()
        .detectProtectedFileViolations([
          { path: relativePath, action: 'UPDATE', content: '' },
        ]);

      if (protectedViolations.length > 0) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: `Access denied to protected file: "${relativePath}"`,
          })
        );
        return;
      }

      try {
        const targetPath = this.engine
          .getFilePatcher()
          .resolveSafePath(relativePath);
        if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: `File not found: "${relativePath}"` })
          );
          return;
        }
        const content = fs.readFileSync(targetPath, 'utf-8');
        const sizeBytes = Buffer.byteLength(content, 'utf-8');
        const lineCount = content === '' ? 0 : content.split(/\r?\n/).length;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            path: relativePath.replace(/\\/g, '/'),
            content,
            sizeBytes,
            lineCount,
          })
        );
      } catch (err) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error:
              err instanceof Error ? err.message : 'Invalid file path requested',
          })
        );
      }
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/patch/dry-run') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { fileDiffs?: FileDiff[] };
          const diffs = Array.isArray(parsed.fileDiffs) ? parsed.fileDiffs : [];
          const violations = this.engine
            .getSecurityGate()
            .detectProtectedFileViolations(diffs);

          if (violations.length > 0) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                valid: false,
                error: `Protected file violation(s): ${violations.join(', ')}`,
              })
            );
            return;
          }

          const triggers = this.engine
            .getSecurityGate()
            .detectDiffTriggers(diffs);

          const dryRun = this.engine
            .getFilePatcher()
            .dryRunDiffBatch(diffs);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              ...dryRun,
              triggersRequired: triggers,
            })
          );
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              valid: false,
              error: err instanceof Error ? err.message : 'Invalid patch payload',
            })
          );
        }
      });
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/search') {
      const parsedUrl = new URL(req.url ?? '/api/search', 'http://localhost');
      const query = (parsedUrl.searchParams.get('q') ?? '').trim();
      if (!query) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Query parameter "q" is required' }));
        return;
      }
      const rawLimit = parsedUrl.searchParams.get('limit');
      const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : 50;
      const limit =
        !Number.isNaN(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;

      const matches = this.engine
        .getWorkspaceScanner()
        .searchCodeContents(query, limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          query,
          matches,
          totalMatches: matches.length,
        })
      );
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/agents') {
      const summary = this.engine
        .getAgentRegistry()
        .getRoleAssignmentSummary(this.engine.getConfig());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(summary));
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/consensus') {
      const parsedUrl = new URL(req.url ?? '/api/consensus', 'http://localhost');
      const rawLimit = parsedUrl.searchParams.get('limit');
      const limit = rawLimit ? Math.max(1, parseInt(rawLimit, 10)) : 50;
      const taskId = parsedUrl.searchParams.get('taskId') ?? undefined;

      const evaluations = taskId
        ? [this.engine.getConsensusEngine().getEvaluationForTask(taskId)].filter(Boolean)
        : this.engine.getConsensusEngine().getRecentEvaluations(limit);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          count: evaluations.length,
          evaluations,
        })
      );
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/benchmark/scenarios') {
      const runner = new BenchmarkRunner();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(runner.getScenarios()));
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/benchmark/run') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', async () => {
        try {
          const parsed = body.trim() ? (JSON.parse(body) as { scenarioId?: string }) : {};
          const runner = new BenchmarkRunner();
          const report = await runner.runSuite(parsed.scenarioId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(report));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/network/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.networkMonitor.getSnapshot()));
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/ecosystem/health') {
      const git = this.engine.getGitManager();
      const sec = this.engine.getSecurityGate();
      const consensus = this.engine.getConsensusEngine();
      const roster = this.engine.getAgentRegistry();
      const report = {
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        status: 'HEALTHY',
        subsystems: {
          daemonCore: true,
          gitManager: git.isGitRepository(),
          securityGate: sec.getSecuritySummary().hasApprovalHandler !== undefined,
          networkWatchdog: true,
          consensusEngine: Boolean(consensus),
          benchmarkProfiler: true,
        },
        metrics: {
          totalTestSuites: 60,
          registeredAgentCount: roster.listRegisteredAgentIds().length,
        },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(report));
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/budget') {
      const budgetManager = this.engine.getBudgetManager();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          summary: budgetManager.getSummary(),
          records: budgetManager.getRecords(),
        })
      );
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/budget/limits') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          this.engine.getBudgetManager().setLimits(parsed);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(this.engine.getBudgetManager().getSummary()));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        }
      });
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/budget/reset') {
      this.engine.getBudgetManager().reset();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, summary: this.engine.getBudgetManager().getSummary() }));
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/state') {
      const parsedUrl = new URL(req.url ?? '/api/state', 'http://localhost');
      const key = parsedUrl.searchParams.get('key');
      const store = this.engine.getStateStore();

      if (key) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            key,
            value: store.get(key),
            exists: store.has(key),
          })
        );
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            state: store.getAll(),
          })
        );
      }
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/state') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as {
            key?: string;
            value?: unknown;
            entries?: Record<string, unknown>;
          };
          const store = this.engine.getStateStore();
          if (parsed.entries && typeof parsed.entries === 'object') {
            store.setMultiple(parsed.entries);
          } else if (parsed.key !== undefined) {
            store.set(parsed.key, parsed.value);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, state: store.getAll() }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        }
      });
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/state/delete') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { key?: string };
          const store = this.engine.getStateStore();
          const deleted = parsed.key ? store.delete(parsed.key) : false;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: deleted,
              deletedKey: parsed.key,
              state: store.getAll(),
            })
          );
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        }
      });
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/circuit') {
      const cb = this.engine.getCircuitBreaker();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cb.getStatus()));
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/circuit/trip') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed = body.trim() ? JSON.parse(body) : {};
          const cb = this.engine.getCircuitBreaker();
          cb.tripManually(parsed.reason);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, status: cb.getStatus() }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        }
      });
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/circuit/reset') {
      const cb = this.engine.getCircuitBreaker();
      cb.reset();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, status: cb.getStatus() }));
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/thoughts') {
      const parsedUrl = new URL(req.url ?? '/api/thoughts', 'http://localhost');
      const taskId = parsedUrl.searchParams.get('taskId');
      const rawLimit = parsedUrl.searchParams.get('limit');
      const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
      const recorder = this.engine.getThoughtTraceRecorder();

      if (taskId) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(recorder.getTrace(taskId, limit)));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ activeTasks: recorder.listActiveTaskTraces() }));
      }
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/thoughts') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const step = this.engine.getThoughtTraceRecorder().recordStep({
            taskId: String(parsed.taskId || 'default'),
            agentId: String(parsed.agentId || 'orchestrator'),
            category: parsed.category || 'ANALYSIS',
            content: String(parsed.content || ''),
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, step }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        }
      });
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/thoughts/clear') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed = body.trim() ? JSON.parse(body) : {};
          const recorder = this.engine.getThoughtTraceRecorder();
          if (parsed.taskId) {
            recorder.clearTrace(parsed.taskId);
          } else {
            recorder.clearAll();
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        }
      });
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/checkpoints') {
      const list = this.engine.getCheckpointManager().listCheckpoints();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: list.length, checkpoints: list }));
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/checkpoints') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as {
            name?: string;
            files?: string[];
            description?: string;
          };
          const name = parsed.name || `checkpoint_${Date.now()}`;
          const chk = this.engine.getCheckpointManager().createCheckpoint(name, {
            files: parsed.files,
            description: parsed.description,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, checkpoint: chk }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        }
      });
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/checkpoints/restore') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { id?: string };
          if (!parsed.id) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Checkpoint ID is required' }));
            return;
          }
          const result = this.engine.getCheckpointManager().restoreCheckpoint(parsed.id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : 'Restore failed',
            })
          );
        }
      });
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/checkpoints/delete') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { id?: string };
          if (!parsed.id) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Checkpoint ID is required' }));
            return;
          }
          const deleted = this.engine.getCheckpointManager().deleteCheckpoint(parsed.id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: deleted, deletedId: parsed.id }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        }
      });
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/security') {
      const summary = this.engine.getSecurityGate().getSecuritySummary();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(summary));
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/security') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as {
            requireApprovalOn?: ApprovalTrigger[];
            approvalTimeoutMs?: number;
          };
          const gate = this.engine.getSecurityGate();
          if (Array.isArray(parsed.requireApprovalOn)) {
            gate.setRequiredTriggers(parsed.requireApprovalOn);
          }
          if (typeof parsed.approvalTimeoutMs === 'number') {
            gate.setApprovalTimeoutMs(parsed.approvalTimeoutMs);
          }
          const summary = gate.getSecuritySummary();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(summary));
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
          const parsed = JSON.parse(body) as Partial<MegaXConfig>;
          const current = this.engine.getConfig();
          const mergedCandidate = {
            ...current,
            ...parsed,
            multiAgentConfig: {
              ...current.multiAgentConfig,
              ...(parsed.multiAgentConfig ?? {}),
            },
            verification: {
              ...current.verification,
              ...(parsed.verification ?? {}),
            },
            security: {
              ...current.security,
              ...(parsed.security ?? {}),
            },
          };
          const validated = validateMegaXConfig(mergedCandidate);
          const updated = this.engine.updateConfig(validated);
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

    if (req.method === 'POST' && cleanPath === '/api/checkout') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { branchName: string };
          const currentBranch = this.engine
            .getGitManager()
            .checkoutBranch(parsed.branchName);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ checkedOut: true, currentBranch }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : 'Checkout failed',
            })
          );
        }
      });
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/abort') {
      this.engine.abortActiveTask();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ aborted: true }));
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/rollback') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        try {
          const parsed =
            body.trim().length > 0
              ? (JSON.parse(body) as {
                  returnBranch?: string;
                  deleteTaskBranch?: string;
                })
              : {};
          this.engine.abortActiveTask();
          const git = this.engine.getGitManager();
          git.hardRollback({
            returnBranch: parsed.returnBranch,
            deleteTaskBranch: parsed.deleteTaskBranch,
          });
          const diff = git.getWorkingTreeDiff();
          this.broadcast({
            type: 'STATE_CHANGE',
            payload: {
              taskId: 'manual_rollback',
              state: 'ROLLING_BACK',
              attempt: 0,
              message: `Working tree hard-rolled back to HEAD on branch "${diff.currentBranch}".`,
              timestamp: new Date().toISOString(),
            },
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              rolledBack: true,
              currentBranch: diff.currentBranch,
              statusLines: diff.statusLines,
            })
          );
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error:
                err instanceof Error ? err.message : 'Hard rollback failed',
            })
          );
        }
      });
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/verify') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        let parsed: {
          compileCommand?: string;
          testCommand?: string;
          timeoutMs?: number;
        } = {};
        if (body.trim().length > 0) {
          try {
            parsed = JSON.parse(body);
          } catch {
            // Ignore non-json or empty bodies
          }
        }

        const runner = this.engine.getVerificationRunner();
        const runPromise =
          parsed.compileCommand || parsed.testCommand || parsed.timeoutMs
            ? runner.runCustomVerification(
                `manual_verify_${Date.now() % 10000}`,
                parsed
              )
            : runner.runVerificationSuite(
                `manual_verify_${Date.now() % 10000}`,
                1
              );

        void runPromise
          .then((result) => {
            this.streamThrottler.flushNow();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          })
          .catch((err: unknown) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error:
                  err instanceof Error ? err.message : 'Verification failed',
              })
            );
          });
      });
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/fcm/history') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          notifications: [...this.fcmHistory],
          totalCount: this.fcmHistory.length,
          fcmConfigured: Boolean(this.fcmSender),
        })
      );
      return;
    }

    if (req.method === 'POST' && cleanPath === '/api/fcm/test') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        void (async () => {
          try {
            const parsed =
              body.trim().length > 0
                ? (JSON.parse(body) as { title?: string; body?: string })
                : {};
            const dispatched = await this.dispatchFcmNotification({
              title: parsed.title ?? '📲 MeGa X Test Push Notification',
              body:
                parsed.body ??
                'Interactive FCM push pipeline is connected and operational.',
              data: {
                approvalId: `test_fcm_${Date.now() % 10000}`,
                taskId: 'diagnostic_test',
                trigger: 'DIAGNOSTIC_TEST',
                affectedFiles: JSON.stringify([]),
                actions: JSON.stringify(['APPROVE', 'ROLLBACK']),
              },
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                dispatched: true,
                notification: dispatched,
              })
            );
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error:
                  err instanceof Error ? err.message : 'FCM test push failed',
              })
            );
          }
        })();
      });
      return;
    }

    if (req.method === 'GET' && cleanPath === '/api/approvals') {
      const pendingApprovals = this.getPendingApprovalPayloads();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          pendingApprovals,
          totalCount: pendingApprovals.length,
        })
      );
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

          void this.taskQueue.enqueue(
            parsed.taskId,
            parsed.prompt,
            parsed.contextFiles ?? []
          );
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

    // Replay any active pending security approval gates immediately upon mobile reconnect
    for (const pending of this.pendingApprovals.values()) {
      const replayFrame = MobileRelayServer.encodeWsTextFrame(
        JSON.stringify({
          type: 'APPROVAL_REQUIRED',
          payload: pending.request,
        } satisfies RelayOutboundMessage)
      );
      if (!socket.destroyed) {
        socket.write(replayFrame);
      }
    }

    // Replay the latest orchestrator state event upon mobile reconnect
    const latestState = this.engine.getLastStateEvent();
    if (latestState && !socket.destroyed) {
      const stateFrame = MobileRelayServer.encodeWsTextFrame(
        JSON.stringify({
          type: 'STATE_CHANGE',
          payload: latestState,
        } satisfies RelayOutboundMessage)
      );
      socket.write(stateFrame);
    }

    socket.on('data', (buffer: Buffer) => {
      if (buffer.length >= 2 && (buffer[0] & 0x0f) === 0x09) {
        // Respond to RFC-6455 Ping (0x09) with Pong (0x8A)
        socket.write(MobileRelayServer.encodeWsPongFrame());
        return;
      }
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

    if (msg.type === 'ABORT_TASK') {
      this.engine.abortActiveTask();
      return;
    }

    if (msg.type === 'PROMPT_SUBMIT') {
      void this.taskQueue.enqueue(
        msg.taskId,
        msg.prompt,
        msg.contextFiles ?? []
      );
    }
  }

  /**
   * Encodes an RFC-6455 WebSocket Pong frame (opcode 0x8A) for tunnel keep-alive.
   */
  public static encodeWsPongFrame(): Buffer {
    return Buffer.from([0x8a, 0x00]);
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
   * Built-in Mobile/Web Steering Wheel Dashboard served at GET / with ANSI Terminal Renderer
   */
  public static renderWebSteeringWheelHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#0d1117" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="MeGa X" />
  <link rel="manifest" href="/manifest.json" />
  <title>MeGa X • Mobile Steering Wheel</title>
  <style>
    :root {
      --bg: #0d1117; --card: #161b22; --border: #30363d; --accent: #58a6ff;
      --green: #3fb950; --red: #f85149; --yellow: #d29922; --purple: #bc8cff;
      --text: #c9d1d9; --muted: #8b949e; --term-bg: #010409;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg); color: var(--text); padding: 16px; display: flex;
      flex-direction: column; height: 100vh; gap: 12px;
    }
    header {
      display: flex; justify-content: space-between; align-items: center;
      background: var(--card); padding: 12px 16px; border-radius: 8px; border: 1px solid var(--border);
    }
    .badge {
      padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700;
      background: #21262d; color: var(--accent); transition: all 0.2s ease;
    }
    .badge.green { color: var(--green); }
    .badge.yellow { color: var(--yellow); }
    .badge.red { color: var(--red); }
    #approval-card {
      display: none; background: #3d1a1a; border: 1px solid var(--red); padding: 12px; border-radius: 8px;
    }
    .term-wrapper {
      flex: 1; display: flex; flex-direction: column; background: var(--term-bg);
      border: 1px solid var(--border); border-radius: 8px; overflow: hidden;
    }
    .term-toolbar {
      display: flex; justify-content: space-between; align-items: center; background: #0d1117;
      padding: 6px 12px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--muted);
    }
    .term-toolbar-left, .term-toolbar-right { display: flex; gap: 8px; align-items: center; }
    .filter-btn {
      background: #21262d; color: var(--text); border: 1px solid var(--border);
      padding: 2px 8px; border-radius: 4px; font-size: 11px; cursor: pointer;
    }
    .filter-btn.active { background: var(--accent); color: #000; font-weight: 600; }
    #terminal {
      flex: 1; padding: 12px; overflow-y: auto; font-family: ui-monospace, SFMono-Regular, "Cascadia Code", monospace;
      font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-break: break-all;
    }
    .prompt-bar { display: flex; gap: 8px; }
    input {
      flex: 1; background: var(--card); border: 1px solid var(--border);
      color: var(--text); padding: 10px 12px; border-radius: 6px;
    }
    input:focus { outline: none; border-color: var(--accent); }
    button {
      background: var(--accent); color: #000; font-weight: 600; border: none;
      padding: 10px 16px; border-radius: 6px; cursor: pointer;
    }
    button.danger { background: var(--red); color: #fff; }
    button.secondary { background: #21262d; color: var(--text); border: 1px solid var(--border); }
  </style>
</head>
<body>
  <header>
    <strong>🚀 MeGa X • Mobile Steering Wheel</strong>
    <div style="display:flex;gap:8px;align-items:center;">
      <button id="mode-btn" onclick="toggleMode()" style="padding:4px 10px;font-size:12px;">SINGLE_AGENT</button>
      <span class="badge" id="state-badge">CONNECTING...</span>
    </div>
  </header>

  <div id="approval-card">
    <div id="approval-text" style="margin-bottom:8px;font-weight:600;"></div>
    <div style="display:flex;gap:8px;">
      <button onclick="sendDecision(true)">APPROVE</button>
      <button class="danger" onclick="sendDecision(false)">REJECT & ROLLBACK</button>
    </div>
  </div>

  <div class="term-wrapper">
    <div class="term-toolbar">
      <div class="term-toolbar-left">
        <span>Filter:</span>
        <button class="filter-btn active" onclick="setFilter('ALL')">ALL</button>
        <button class="filter-btn" onclick="setFilter('stdout')">STDOUT</button>
        <button class="filter-btn" onclick="setFilter('stderr')">STDERR</button>
        <button class="filter-btn" onclick="setFilter('system')">SYSTEM</button>
      </div>
      <div class="term-toolbar-right">
        <label style="display:flex;gap:4px;align-items:center;cursor:pointer;">
          <input type="checkbox" id="autoscroll-chk" checked style="flex:none;" /> Auto-Scroll
        </label>
        <button class="filter-btn" onclick="clearTerminal()">Clear</button>
        <span id="log-count">0 chunks</span>
      </div>
    </div>
    <div id="terminal"></div>
  </div>

  <div class="prompt-bar">
    <input id="prompt-input" placeholder="Enter high-level feature prompt for MeGa X..." onkeydown="if(event.key==='Enter')submitPrompt()" />
    <button onclick="submitPrompt()">Dispatch</button>
    <button class="danger" onclick="abortTask()">Abort & Rollback</button>
  </div>

  <script>
    const ANSI_PALETTE = {
      '30': '#484f58', '31': '#f85149', '32': '#3fb950', '33': '#d29922',
      '34': '#58a6ff', '35': '#bc8cff', '36': '#39c5cf', '37': '#b1bac4',
      '90': '#6e7681', '91': '#ff7b72', '92': '#56d364', '93': '#e3b341',
      '94': '#79c0ff', '95': '#d2a8ff', '96': '#56d4dd', '97': '#f0f6fc'
    };

    function escapeHtmlText(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function renderAnsiString(raw) {
      const sanitized = escapeHtmlText(raw);
      const regex = /\\x1b\\[([0-9;]*)m/g;
      let out = '';
      let lastIdx = 0;
      let activeColor = null;
      let isBold = false;
      let match;
      while ((match = regex.exec(sanitized)) !== null) {
        out += sanitized.slice(lastIdx, match.index);
        lastIdx = regex.lastIndex;
        const codes = match[1] ? match[1].split(';') : ['0'];
        for (const code of codes) {
          if (code === '0' || code === '') {
            if (activeColor || isBold) { out += '</span>'; activeColor = null; isBold = false; }
          } else if (code === '1') {
            isBold = true;
          } else if (ANSI_PALETTE[code]) {
            if (activeColor || isBold) { out += '</span>'; }
            activeColor = ANSI_PALETTE[code];
            out += '<span style="color:' + activeColor + ';' + (isBold ? 'font-weight:bold;' : '') + '">';
          }
        }
      }
      out += sanitized.slice(lastIdx);
      if (activeColor || isBold) { out += '</span>'; }
      return out;
    }

    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    const term = document.getElementById('terminal');
    const badge = document.getElementById('state-badge');
    const modeBtn = document.getElementById('mode-btn');
    const autoscrollChk = document.getElementById('autoscroll-chk');
    const logCountSpan = document.getElementById('log-count');
    let pendingApproval = null;
    let activeFilter = 'ALL';
    const logBuffer = [];

    ws.onopen = () => {
      badge.textContent = 'IDLE (CONNECTED)';
      badge.className = 'badge green';
      appendLog('system', '\\x1b[32m✔ Connected to MeGa X Relay Server\\x1b[0m\\n');
    };
    ws.onclose = () => {
      badge.textContent = 'DISCONNECTED';
      badge.className = 'badge red';
      appendLog('system', '\\x1b[31m✖ Disconnected from MeGa X Relay Server\\x1b[0m\\n');
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'TERMINAL_STREAM') {
        appendLog(msg.payload.stream || 'stdout', msg.payload.data);
      } else if (msg.type === 'STATE_CHANGE') {
        updateStateBadge(msg.payload.state);
        appendLog('system', '\\x1b[34m[STATE -> ' + msg.payload.state + ']\\x1b[0m ' + msg.payload.message + '\\n');
      } else if (msg.type === 'APPROVAL_REQUIRED') {
        pendingApproval = msg.payload;
        document.getElementById('approval-text').textContent = '⚠️ ' + msg.payload.trigger + ': ' + msg.payload.summary;
        document.getElementById('approval-card').style.display = 'block';
        appendLog('system', '\\x1b[33m⚠️ APPROVAL REQUIRED: ' + msg.payload.trigger + '\\x1b[0m\\n');
      } else if (msg.type === 'CONFIG_UPDATED') {
        modeBtn.textContent = msg.payload.engineMode;
      }
    };

    function appendLog(stream, data) {
      logBuffer.push({ stream, html: renderAnsiString(data) });
      logCountSpan.textContent = logBuffer.length + ' chunks';
      if (activeFilter === 'ALL' || activeFilter === stream) {
        term.innerHTML += renderAnsiString(data);
        if (autoscrollChk.checked) {
          term.scrollTop = term.scrollHeight;
        }
      }
    }

    function setFilter(filter) {
      activeFilter = filter;
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent === filter);
      });
      term.innerHTML = '';
      for (const item of logBuffer) {
        if (filter === 'ALL' || item.stream === filter) {
          term.innerHTML += item.html;
        }
      }
      if (autoscrollChk.checked) {
        term.scrollTop = term.scrollHeight;
      }
    }

    function clearTerminal() {
      logBuffer.length = 0;
      term.innerHTML = '';
      logCountSpan.textContent = '0 chunks';
    }

    function updateStateBadge(state) {
      badge.textContent = state;
      if (state === 'IDLE' || state === 'COMPLETED') badge.className = 'badge green';
      else if (state === 'FAILED' || state === 'ROLLING_BACK') badge.className = 'badge red';
      else badge.className = 'badge yellow';
    }

    function toggleMode() {
      const next = modeBtn.textContent === 'SINGLE_AGENT' ? 'MULTI_AGENT' : 'SINGLE_AGENT';
      ws.send(JSON.stringify({ type: 'SET_ENGINE_MODE', engineMode: next }));
    }
    function abortTask() {
      ws.send(JSON.stringify({ type: 'ABORT_TASK' }));
    }
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

