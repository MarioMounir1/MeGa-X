import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  MockReplayAgentAdapter,
  PatternMatchMockAdapter,
  saveReplayFixture,
  loadReplayFixture,
  createDeterministicReplayRegistry,
  FixtureData,
} from '../agents/mockReplayEngine';
import { AgentTaskPayload } from '../types/contracts';

describe('Phase 53: Deterministic Mock AI Replay Engine for Offline CI Testing', () => {
  it('replays multi-turn interactions in sequential order with fallback handling', async () => {
    const adapter = new MockReplayAgentAdapter(
      'mock-claude',
      [
        {
          turn: 1,
          response: {
            taskId: 'orig',
            explanation: 'Turn 1 execution',
            fileDiffs: [{ path: 'test.ts', content: 'const a = 1;', action: 'CREATE' }],
          },
        },
        {
          turn: 2,
          response: {
            taskId: 'orig',
            explanation: 'Turn 2 execution',
            fileDiffs: [{ path: 'test.ts', content: 'const a = 2;', action: 'UPDATE' }],
          },
        },
      ],
      (payload, turn) => ({
        taskId: payload.taskId,
        explanation: `Fallback turn ${turn}`,
        fileDiffs: [],
      })
    );

    const payload: AgentTaskPayload = {
      taskId: 'task_turn_test',
      prompt: 'Do something',
    };

    // Turn 1
    const res1 = await adapter.execute(payload);
    assert.strictEqual(res1.taskId, 'task_turn_test');
    assert.strictEqual(res1.explanation, 'Turn 1 execution');
    assert.strictEqual(res1.fileDiffs[0].content, 'const a = 1;');

    // Turn 2
    const res2 = await adapter.execute(payload);
    assert.strictEqual(res2.explanation, 'Turn 2 execution');
    assert.strictEqual(res2.fileDiffs[0].content, 'const a = 2;');

    // Turn 3 (Fallback)
    const res3 = await adapter.execute(payload);
    assert.strictEqual(res3.explanation, 'Fallback turn 3');
    assert.strictEqual(adapter.getTurnCount(), 3);
  });

  it('evaluates dynamic pattern rules against prompt text and self-healing error logs', async () => {
    const adapter = new PatternMatchMockAdapter('rule-agent', [
      {
        pattern: 'SYNTAX_ERROR',
        targetField: 'errorLog',
        response: (payload) => ({
          taskId: payload.taskId,
          explanation: 'Healed syntax error',
          fileDiffs: [{ path: 'app.ts', content: 'export const ok = true;', action: 'UPDATE' }],
        }),
      },
      {
        pattern: 'INITIAL_BUILD',
        targetField: 'prompt',
        response: (payload) => ({
          taskId: payload.taskId,
          explanation: 'Initial broken build',
          fileDiffs: [{ path: 'app.ts', content: 'export const broken =', action: 'CREATE' }],
        }),
      },
    ]);

    // Initial prompt match
    const r1 = await adapter.execute({
      taskId: 'p1',
      prompt: 'Run INITIAL_BUILD for project',
    });
    assert.strictEqual(r1.explanation, 'Initial broken build');

    // Error log match
    const r2 = await adapter.execute({
      taskId: 'p1',
      prompt: 'Fix it',
      errorLog: 'Compiler failure: SYNTAX_ERROR on line 1',
    });
    assert.strictEqual(r2.explanation, 'Healed syntax error');
    assert.strictEqual(r2.fileDiffs[0].content, 'export const ok = true;');
  });

  it('saves and loads deterministic replay fixtures to/from disk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-fixture-test-'));
    const fixturePath = path.join(tempDir, 'sample-fixture.json');

    try {
      const fixture: FixtureData = {
        name: 'self-healing-showcase',
        version: '1.0.0',
        interactions: [
          {
            turn: 1,
            promptSnippet: 'create app',
            response: {
              taskId: 't1',
              explanation: 'step 1',
              fileDiffs: [],
            },
          },
        ],
      };

      saveReplayFixture(fixturePath, fixture);
      assert.strictEqual(fs.existsSync(fixturePath), true);

      const loaded = loadReplayFixture(fixturePath);
      assert.strictEqual(loaded.name, 'self-healing-showcase');
      assert.strictEqual(loaded.interactions.length, 1);
      assert.strictEqual(loaded.interactions[0].response.explanation, 'step 1');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('creates deterministic replay registry with pre-scripted self-healing sequence', () => {
    const registry = createDeterministicReplayRegistry({
      targetFile: 'src/main.ts',
      failingCode: 'const x: number = "err";',
      healingCode: 'const x: number = 100;',
    });

    const claude = registry.get('claude-3-7-sonnet');
    assert.ok(claude);
    assert.strictEqual(claude.agentId, 'claude-3-7-sonnet');

    const antigravity = registry.get('antigravity');
    assert.ok(antigravity);

    const codex = registry.get('codex');
    assert.ok(codex);
  });
});
