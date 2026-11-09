import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AgentRegistry,
  ConfigurableAgentAdapter,
} from '../agents/agentRegistry';
import { GitManager } from '../git/gitManager';
import {
  OrchestratorEngine,
  TaskStateChangeEvent,
} from '../orchestrator/orchestratorEngine';
import { MegaXConfig } from '../types/contracts';

function createBaseConfig(mode: 'SINGLE_AGENT' | 'MULTI_AGENT'): MegaXConfig {
  return {
    projectName: 'Target-Project',
    engineMode: mode,
    primaryAgent: 'claude-3-7-sonnet',
    multiAgentConfig: {
      planner: 'claude-3-7-sonnet',
      executor: 'antigravity',
      reviewer: 'codex',
    },
    verification: {
      compileCommand: 'node -e "process.exit(0)"',
      testCommand: 'node test.js',
      maxFixAttempts: 3,
    },
    security: {
      requireApprovalOn: ['DB_MIGRATION', 'FILE_DELETE', 'MAX_RETRY_EXCEEDED'],
    },
  };
}

describe('Phase 4: Dual-Mode Orchestrator & Self-Healing Loop', () => {
  let tempDir: string;
  let git: GitManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase4-'));
    git = new GitManager(tempDir);
    git.runGit(['init']);
    git.runGit(['config', 'user.email', 'daemon@megax.local']);
    git.runGit(['config', 'user.name', 'MeGa X Daemon']);

    // Create a real test runner script in tempDir that validates math.js
    fs.writeFileSync(
      path.join(tempDir, 'test.js'),
      `
      const assert = require('node:assert/strict');
      const { add } = require('./math.js');
      assert.equal(add(2, 3), 5, 'Expected add(2, 3) to equal 5');
      console.log('Unit test passed!');
      `,
      'utf-8'
    );
    fs.writeFileSync(
      path.join(tempDir, 'math.js'),
      'module.exports = { add: () => 0 };\n',
      'utf-8'
    );
    git.commitAll('chore: initial project setup');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('SINGLE_AGENT: fails on attempt 1, reads stack trace in errorLog, heals code on attempt 2, and commits', async () => {
    const registry = new AgentRegistry();
    const capturedErrorLogs: (string | undefined)[] = [];
    const stateEvents: TaskStateChangeEvent[] = [];

    registry.register(
      new ConfigurableAgentAdapter('claude-3-7-sonnet', {
        onExecute: (payload) => {
          capturedErrorLogs.push(payload.errorLog);

          // Attempt 1 (no errorLog yet): write buggy implementation (2 - 3 = -1)
          if (!payload.errorLog) {
            return {
              taskId: payload.taskId,
              explanation: 'Initial attempt at add()',
              fileDiffs: [
                {
                  path: 'math.js',
                  content: 'module.exports = { add: (a, b) => a - b };\n',
                  action: 'UPDATE',
                },
              ],
            };
          }

          // Attempt 2 (self-healing with captured stack trace): fix bug (a + b)
          return {
            taskId: payload.taskId,
            explanation: 'Fixed add() using stack trace feedback',
            fileDiffs: [
              {
                path: 'math.js',
                content: 'module.exports = { add: (a, b) => a + b };\n',
                action: 'UPDATE',
              },
            ],
          };
        },
      })
    );

    const engine = new OrchestratorEngine({
      workspaceRoot: tempDir,
      config: createBaseConfig('SINGLE_AGENT'),
      agentRegistry: registry,
      onStateChange: (evt) => stateEvents.push(evt),
    });

    const result = await engine.runFeaturePrompt(
      'task_heal',
      'Fix add function in math.js'
    );

    assert.equal(result.overallSuccess, true);
    assert.equal(result.microTaskResults.length, 1);
    assert.equal(result.microTaskResults[0].status, 'COMPLETED');
    assert.equal(result.microTaskResults[0].attemptsUsed, 2);
    assert.ok(result.microTaskResults[0].commitHash);
    assert.equal(git.getCurrentBranch(), 'megax/task_heal');

    // Verify Attempt 1 had no errorLog and Attempt 2 received the AssertionError stack trace
    assert.equal(capturedErrorLogs[0], undefined);
    assert.ok(
      capturedErrorLogs[1]?.includes('Expected add(2, 3) to equal 5')
    );
    assert.ok(stateEvents.some((e) => e.state === 'SELF_HEALING'));
  });

  it('Executes hard git rollback and triggers MAX_RETRY_EXCEEDED when all 3 attempts fail', async () => {
    const registry = new AgentRegistry();
    let maxRetryTriggerFired = false;

    registry.register(
      new ConfigurableAgentAdapter('claude-3-7-sonnet', {
        onExecute: (payload) => ({
          taskId: payload.taskId,
          explanation: 'Still broken implementation',
          fileDiffs: [
            {
              path: 'math.js',
              content: 'module.exports = { add: () => 999 };\n',
              action: 'UPDATE',
            },
          ],
        }),
      })
    );

    const baseBranch = git.getCurrentBranch();
    const engine = new OrchestratorEngine({
      workspaceRoot: tempDir,
      config: createBaseConfig('SINGLE_AGENT'),
      agentRegistry: registry,
      onApprovalRequest: async (req) => {
        if (req.trigger === 'MAX_RETRY_EXCEEDED') {
          maxRetryTriggerFired = true;
        }
        return {
          approvalId: req.approvalId,
          taskId: req.taskId,
          approved: true,
        };
      },
    });

    const result = await engine.runFeaturePrompt(
      'task_fail_3x',
      'Impossible task'
    );

    assert.equal(result.overallSuccess, false);
    assert.equal(result.microTaskResults[0].status, 'ROLLED_BACK');
    assert.equal(result.microTaskResults[0].attemptsUsed, 3);
    assert.equal(maxRetryTriggerFired, true);

    // Confirm Git hard rollback restored original branch and original math.js content
    assert.equal(git.getCurrentBranch(), baseBranch);
    assert.equal(
      fs
        .readFileSync(path.join(tempDir, 'math.js'), 'utf-8')
        .replace(/\r\n/g, '\n'),
      'module.exports = { add: () => 0 };\n'
    );
  });

  it('MULTI_AGENT: coordinates Planner (Claude) -> Executor (AntiGravity) -> Reviewer (Codex)', async () => {
    const registry = new AgentRegistry();
    let reviewerCalled = false;

    // 1. Planner (claude-3-7-sonnet)
    registry.register(
      new ConfigurableAgentAdapter('claude-3-7-sonnet', {
        onPlan: (payload) => ({
          taskId: payload.taskId,
          explanation: 'Split into 2 micro-tasks',
          fileDiffs: [],
          microTasks: [
            'Implement add(a, b) in math.js',
            'Add multiply(a, b) helper in math.js',
          ],
        }),
      })
    );

    // 2. Executor (antigravity)
    registry.register(
      new ConfigurableAgentAdapter('antigravity', {
        onExecute: (payload) => ({
          taskId: payload.taskId,
          explanation: `Executed: ${payload.prompt}`,
          fileDiffs: [
            {
              path: 'math.js',
              content:
                'module.exports = { add: (a, b) => a + b, multiply: (a, b) => a * b };\n',
              action: 'UPDATE',
            },
          ],
        }),
      })
    );

    // 3. Reviewer (codex)
    registry.register(
      new ConfigurableAgentAdapter('codex', {
        onReview: (_payload, diffs) => {
          reviewerCalled = true;
          return {
            approved: diffs.length > 0,
            feedback: 'Clean implementation verified by Codex.',
          };
        },
      })
    );

    const engine = new OrchestratorEngine({
      workspaceRoot: tempDir,
      config: createBaseConfig('MULTI_AGENT'),
      agentRegistry: registry,
    });

    const result = await engine.runFeaturePrompt(
      'feature_math',
      'Upgrade math module'
    );

    assert.equal(result.overallSuccess, true);
    assert.equal(result.engineMode, 'MULTI_AGENT');
    assert.equal(result.microTaskResults.length, 2);
    assert.equal(reviewerCalled, true);
    assert.equal(result.microTaskResults[0].status, 'COMPLETED');
    assert.equal(result.microTaskResults[1].status, 'COMPLETED');
  });
});

