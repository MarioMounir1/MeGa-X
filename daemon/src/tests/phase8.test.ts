import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AgentRegistry,
  ConfigurableAgentAdapter,
} from '../agents/agentRegistry';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { WorkspaceScanner } from '../patcher/workspaceScanner';
import { MobileRelayServer } from '../relay/mobileRelayServer';
import { MegaXConfig } from '../types/contracts';

describe('Phase 8: Automatic Context Discovery & Persistent Task Audit Store', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase8-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'authService.ts'),
      'export function verifyJwtToken(token: string) { return true; }\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'billingService.ts'),
      'export function chargeInvoice(amount: number) { return amount; }\n',
      'utf-8'
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('WorkspaceScanner ranks and discovers relevant context files from prompt keywords', () => {
    const scanner = new WorkspaceScanner(tempDir);
    const context = scanner.discoverContextForPrompt(
      'Update verifyJwtToken in authService'
    );

    assert.equal(context.length, 2);
    assert.equal(context[0].path, 'src/authService.ts');
    assert.ok(context[0].content.includes('verifyJwtToken'));
  });

  it('OrchestratorEngine auto-discovers context files, records audit history, and serves GET /api/history', async () => {
    let receivedContextPaths: string[] = [];
    const registry = new AgentRegistry();

    registry.register(
      new ConfigurableAgentAdapter('claude-3-7-sonnet', {
        onExecute: (payload) => {
          receivedContextPaths = (payload.contextFiles ?? []).map(
            (f) => f.path
          );
          return {
            taskId: payload.taskId,
            explanation: 'Updated authService.ts',
            fileDiffs: [],
          };
        },
      })
    );

    const config: MegaXConfig = {
      projectName: 'Target-Project',
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
        maxFixAttempts: 3,
      },
      security: {
        requireApprovalOn: ['FILE_DELETE'],
      },
    };

    const engine = new OrchestratorEngine({
      workspaceRoot: tempDir,
      config,
      agentRegistry: registry,
    });

    await engine.runFeaturePrompt(
      'audit_task_01',
      'Enhance verifyJwtToken in authService'
    );

    // Ensure context files were automatically discovered without explicit paths
    assert.ok(receivedContextPaths.includes('src/authService.ts'));

    const relay = new MobileRelayServer(engine);
    const port = await relay.start(0, '127.0.0.1');

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/history`);
      assert.equal(res.status, 200);
      const data = (await res.json()) as {
        history: { masterTaskId: string; overallSuccess: boolean }[];
      };
      assert.equal(data.history.length, 1);
      assert.equal(data.history[0].masterTaskId, 'audit_task_01');
      assert.equal(data.history[0].overallSuccess, true);
    } finally {
      await relay.stop();
    }
  });
});

