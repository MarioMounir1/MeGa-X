import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgentRegistry,
  ConfigurableAgentAdapter,
} from './agents/agentRegistry';
import { GitManager } from './git/gitManager';
import { OrchestratorEngine } from './orchestrator/orchestratorEngine';
import { FcmDispatcher } from './relay/fcmDispatcher';
import { MobileRelayServer } from './relay/mobileRelayServer';
import { MegaXConfig } from './types/contracts';

/**
 * Runs a live, self-contained showcase of MeGa X:
 * 1. Creates a temporary Git workspace with a unit test suite.
 * 2. Boots the OrchestratorEngine + FcmDispatcher + MobileRelayServer.
 * 3. Runs a task that intentionally fails Attempt 1, captures the stack trace,
 *    heals the code on Attempt 2, passes verification, and auto-commits to `megax/demo_task_01`.
 */
export async function runLiveSelfHealingDemo(): Promise<void> {
  const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-live-demo-'));
  console.log(`\n📂 Created isolated demo workspace: ${demoDir}`);

  const git = new GitManager(demoDir);
  git.runGit(['init']);
  git.runGit(['config', 'user.email', 'daemon@megax.local']);
  git.runGit(['config', 'user.name', 'MeGa X Daemon']);

  fs.writeFileSync(
    path.join(demoDir, 'calculator.js'),
    'module.exports = { multiply: (a, b) => 0 };\n',
    'utf-8'
  );
  fs.writeFileSync(
    path.join(demoDir, 'test.js'),
    `
    const assert = require('node:assert/strict');
    const { multiply } = require('./calculator.js');
    assert.equal(multiply(6, 7), 42, 'Expected multiply(6, 7) to equal 42');
    console.log('✅ All calculator unit tests passed!');
    `,
    'utf-8'
  );
  git.commitAll('chore: initial commit');

  const registry = new AgentRegistry();
  registry.register(
    new ConfigurableAgentAdapter('claude-3-7-sonnet', {
      onExecute: (payload) => {
        if (!payload.errorLog) {
          console.log(
            `\n🤖 [Attempt 1] Agent writing initial code (with intentional bug: a + b)...`
          );
          return {
            taskId: payload.taskId,
            explanation: 'Initial implementation of multiply()',
            fileDiffs: [
              {
                path: 'calculator.js',
                content: 'module.exports = { multiply: (a, b) => a + b };\n',
                action: 'UPDATE',
              },
            ],
          };
        }

        console.log(
          `\n🔧 [Attempt 2 - SELF-HEALING] Agent received stack trace:\n${payload.errorLog
            .split('\n')
            .slice(0, 5)
            .join('\n')}`
        );
        console.log(`🤖 [Attempt 2] Agent patching calculator.js -> a * b...`);
        return {
          taskId: payload.taskId,
          explanation: 'Healed multiply() bug using captured stack trace',
          fileDiffs: [
            {
              path: 'calculator.js',
              content: 'module.exports = { multiply: (a, b) => a * b };\n',
              action: 'UPDATE',
            },
          ],
        };
      },
    })
  );

  const config: MegaXConfig = {
    projectName: 'MeGa-X-Live-Demo',
    engineMode: 'SINGLE_AGENT',
    primaryAgent: 'claude-3-7-sonnet',
    multiAgentConfig: {
      planner: 'claude-3-7-sonnet',
      executor: 'antigravity',
      reviewer: 'codex',
    },
    verification: {
      compileCommand: 'node -e "console.log(\'TypeScript check OK\')"',
      testCommand: 'node test.js',
      maxFixAttempts: 3,
    },
    security: {
      requireApprovalOn: ['DB_MIGRATION', 'FILE_DELETE', 'MAX_RETRY_EXCEEDED'],
    },
  };

  const fcm = new FcmDispatcher({ logToConsole: true });
  const engine = new OrchestratorEngine({
    workspaceRoot: demoDir,
    config,
    agentRegistry: registry,
  });

  const relay = new MobileRelayServer(engine, fcm.createSender());
  const port = await relay.start(0, '127.0.0.1');
  console.log(`📡 Live Relay Server active on http://127.0.0.1:${port}`);

  try {
    const result = await engine.runFeaturePrompt(
      'demo_task_01',
      'Implement multiply(a, b) in calculator.js'
    );

    console.log('\n==================================================');
    console.log(`🎉 DEMO COMPLETE!`);
    console.log(`   Overall Success : ${result.overallSuccess}`);
    console.log(`   Git Branch      : ${result.microTaskResults[0].branchName}`);
    console.log(
      `   Attempts Used   : ${result.microTaskResults[0].attemptsUsed}`
    );
    console.log(`   Commit Hash     : ${result.microTaskResults[0].commitHash}`);
    console.log('==================================================\n');
  } finally {
    await relay.stop();
    fs.rmSync(demoDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void runLiveSelfHealingDemo();
}

