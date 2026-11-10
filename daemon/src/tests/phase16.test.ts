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
import { TaskQueueManager } from '../orchestrator/taskQueue';
import { SecurityGate } from '../security/securityGate';
import { MegaXConfig } from '../types/contracts';

describe('Phase 16: FIFO Task Queue Mutex & Approval Timeout Auto-Rollback', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase16-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('SecurityGate automatically rejects when approvalTimeoutMs expires without mobile response', async () => {
    const gate = new SecurityGate(
      { requireApprovalOn: ['FILE_DELETE'] },
      // Handler that never resolves (simulating offline mobile user)
      () => new Promise(() => {}),
      50 // 50ms timeout
    );

    const decision = await gate.verifyDiffsOrWait('task_timeout', [
      { path: 'important.ts', content: '', action: 'DELETE' },
    ]);

    assert.equal(decision.approved, false);
    assert.equal(decision.rejectedBy, 'FILE_DELETE');
    assert.ok(decision.note?.includes('timed out'));
  });

  it('TaskQueueManager serializes concurrent mobile prompts in strict FIFO order without overlapping', async () => {
    const executionOrder: string[] = [];
    const registry = new AgentRegistry();

    registry.register(
      new ConfigurableAgentAdapter('claude-3-7-sonnet', {
        onExecute: async (payload) => {
          executionOrder.push(`START_${payload.taskId}`);
          await new Promise((r) => setTimeout(r, 40));
          executionOrder.push(`END_${payload.taskId}`);
          return {
            taskId: payload.taskId,
            explanation: 'Done',
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
    const queue = new TaskQueueManager(engine);

    // Enqueue two tasks simultaneously
    const [res1, res2] = await Promise.all([
      queue.enqueue('q_task_1', 'First prompt'),
      queue.enqueue('q_task_2', 'Second prompt'),
    ]);

    assert.equal(res1.overallSuccess, true);
    assert.equal(res2.overallSuccess, true);

    // Ensure q_task_1 completely finished before q_task_2 started
    assert.deepEqual(executionOrder, [
      'START_q_task_1',
      'END_q_task_1',
      'START_q_task_2',
      'END_q_task_2',
    ]);

    const snapshot = queue.getQueueSnapshot();
    assert.equal(snapshot.length, 2);
    assert.equal(snapshot[0].status, 'COMPLETED');
    assert.equal(snapshot[1].status, 'COMPLETED');
  });
});

