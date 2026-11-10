import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'node:test';
import {
  AgentRegistry,
  ConfigurableAgentAdapter,
} from '../agents/agentRegistry';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { MobileRelayServer } from '../relay/mobileRelayServer';
import { MegaXConfig } from '../types/contracts';

function createTestConfig(): MegaXConfig {
  return {
    projectName: 'Phase32-Queue-Test',
    engineMode: 'SINGLE_AGENT',
    primaryAgent: 'slow-agent',
    multiAgentConfig: {
      planner: 'slow-agent',
      executor: 'slow-agent',
      reviewer: 'slow-agent',
    },
    verification: {
      compileCommand: 'node -e "process.exit(0)"',
      testCommand: 'node -e "process.exit(0)"',
      maxFixAttempts: 1,
    },
    security: {
      requireApprovalOn: ['FILE_DELETE', 'DB_MIGRATION', 'MAX_RETRY_EXCEEDED'],
    },
  };
}

function httpRequestJson(
  url: string,
  method: 'GET' | 'POST',
  payload?: Record<string, unknown>
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyStr = payload ? JSON.stringify(payload) : undefined;
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: bodyStr
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(bodyStr),
            }
          : undefined,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => {
          raw += chunk.toString('utf-8');
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: JSON.parse(raw) as Record<string, unknown>,
          });
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

describe('Phase 32: Queue Cancellation & Completed Queue Pruning (/api/queue/cancel & /api/queue/clear)', () => {
  it('cancels a waiting QUEUED task before execution and prunes finished tasks via /api/queue/clear', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-p32-'));
    let relay: MobileRelayServer | undefined;
    const executedTaskIds: string[] = [];

    try {
      const registry = new AgentRegistry();
      registry.register(
        new ConfigurableAgentAdapter('slow-agent', {
          onExecute: async (payload) => {
            executedTaskIds.push(payload.taskId);
            await new Promise((r) => setTimeout(r, 150));
            return {
              taskId: payload.taskId,
              explanation: `Done ${payload.taskId}`,
              fileDiffs: [
                {
                  path: `src/${payload.taskId}.ts`,
                  action: 'CREATE',
                  content: `export const id = "${payload.taskId}";\n`,
                },
              ],
            };
          },
        })
      );

      const engine = new OrchestratorEngine({
        workspaceRoot: tempDir,
        config: createTestConfig(),
        agentRegistry: registry,
      });

      relay = new MobileRelayServer(engine, undefined, '');
      const port = await relay.start(0);

      // Enqueue 3 tasks rapidly: task-1 starts RUNNING immediately, task-2 and task-3 are QUEUED
      await httpRequestJson(`http://127.0.0.1:${port}/api/prompt`, 'POST', {
        taskId: 'task-1',
        prompt: 'First task',
      });
      await httpRequestJson(`http://127.0.0.1:${port}/api/prompt`, 'POST', {
        taskId: 'task-2',
        prompt: 'Second task (to be cancelled)',
      });
      await httpRequestJson(`http://127.0.0.1:${port}/api/prompt`, 'POST', {
        taskId: 'task-3',
        prompt: 'Third task',
      });

      // Cancel task-2 while task-1 is still running
      const cancelRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/queue/cancel`,
        'POST',
        { taskId: 'task-2' }
      );
      assert.strictEqual(cancelRes.statusCode, 200);
      assert.strictEqual(cancelRes.body.cancelled, true);

      // Trying to cancel task-1 (already RUNNING) returns 404
      const cancelRunningRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/queue/cancel`,
        'POST',
        { taskId: 'task-1' }
      );
      assert.strictEqual(cancelRunningRes.statusCode, 404);

      // Wait for task-1 and task-3 to finish
      for (let i = 0; i < 40; i++) {
        const pollRes = await httpRequestJson(
          `http://127.0.0.1:${port}/api/queue`,
          'GET'
        );
        const items = pollRes.body.queue as Array<{
          taskId: string;
          status: string;
        }>;
        const t3 = items.find((q) => q.taskId === 'task-3');
        if (t3 && t3.status === 'COMPLETED') {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      // Verify task-2 never executed
      assert.deepStrictEqual(executedTaskIds, ['task-1', 'task-3']);

      const queueRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/queue`,
        'GET'
      );
      const snapshot = queueRes.body.queue as Array<{
        taskId: string;
        status: string;
      }>;
      assert.strictEqual(snapshot.length, 3);
      assert.strictEqual(
        snapshot.find((q) => q.taskId === 'task-2')?.status,
        'CANCELLED'
      );

      // Prune all finished tasks via POST /api/queue/clear
      const clearRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/queue/clear`,
        'POST'
      );
      assert.strictEqual(clearRes.statusCode, 200);
      assert.strictEqual(clearRes.body.clearedCount, 3);
      assert.strictEqual(clearRes.body.remainingCount, 0);
    } finally {
      if (relay) {
        await relay.stop();
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
