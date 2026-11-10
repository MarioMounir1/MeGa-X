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
    projectName: 'Phase38-Agents-Test',
    engineMode: 'SINGLE_AGENT',
    primaryAgent: 'claude-3-7-sonnet',
    multiAgentConfig: {
      planner: 'claude-3-7-sonnet',
      executor: 'antigravity',
      reviewer: 'codex',
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

describe('Phase 38: AI Agent Roster & Role Assignment Inspector (/api/agents — 60-Test Milestone)', () => {
  it('returns registered agents and active role assignments in SINGLE_AGENT and MULTI_AGENT modes via GET /api/agents', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-p38-'));
    let relay: MobileRelayServer | undefined;

    try {
      const registry = new AgentRegistry();
      registry.register(new ConfigurableAgentAdapter('gemini-2-5-pro'));

      const engine = new OrchestratorEngine({
        workspaceRoot: tempDir,
        config: createTestConfig(),
        agentRegistry: registry,
      });

      relay = new MobileRelayServer(engine, undefined, '');
      const port = await relay.start(0);

      // 1. Inspect GET /api/agents in SINGLE_AGENT mode
      const singleRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/agents`,
        'GET'
      );
      assert.strictEqual(singleRes.statusCode, 200);
      assert.strictEqual(singleRes.body.engineMode, 'SINGLE_AGENT');
      const registered = singleRes.body.registeredAgents as string[];
      assert.ok(registered.includes('claude-3-7-sonnet'));
      assert.ok(registered.includes('antigravity'));
      assert.ok(registered.includes('codex'));
      assert.ok(registered.includes('gemini-2-5-pro'));

      const singleRoles = singleRes.body.activeRoles as {
        primaryAgent: string;
        planner: string;
        executor: string;
        reviewer: string | null;
      };
      assert.strictEqual(singleRoles.primaryAgent, 'claude-3-7-sonnet');
      assert.strictEqual(singleRoles.planner, 'claude-3-7-sonnet');
      assert.strictEqual(singleRoles.executor, 'claude-3-7-sonnet');
      assert.strictEqual(singleRoles.reviewer, null);

      // 2. Switch to MULTI_AGENT and assign gemini-2-5-pro as Reviewer via POST /api/config
      const patchRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/config`,
        'POST',
        {
          engineMode: 'MULTI_AGENT',
          multiAgentConfig: {
            planner: 'claude-3-7-sonnet',
            executor: 'antigravity',
            reviewer: 'gemini-2-5-pro',
          },
        }
      );
      assert.strictEqual(patchRes.statusCode, 200);

      // 3. Re-inspect GET /api/agents in MULTI_AGENT mode
      const multiRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/agents`,
        'GET'
      );
      assert.strictEqual(multiRes.statusCode, 200);
      assert.strictEqual(multiRes.body.engineMode, 'MULTI_AGENT');
      const multiRoles = multiRes.body.activeRoles as {
        primaryAgent: string;
        planner: string;
        executor: string;
        reviewer: string | null;
      };
      assert.strictEqual(multiRoles.planner, 'claude-3-7-sonnet');
      assert.strictEqual(multiRoles.executor, 'antigravity');
      assert.strictEqual(multiRoles.reviewer, 'gemini-2-5-pro');
    } finally {
      if (relay) {
        await relay.stop();
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

