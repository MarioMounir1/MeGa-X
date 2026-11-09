import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  AntiGravityAgentAdapter,
  buildAgentUserPrompt,
  ClaudeAgentAdapter,
  CodexAgentAdapter,
  parseAgentJsonResponse,
} from '../agents/liveProviders';

describe('Phase 6: Live AI Provider Adapters & Prompt/Response Formatting', () => {
  it('parseAgentJsonResponse strips markdown code fences and parses FileDiff[]', () => {
    const rawLlmOutput = `\`\`\`json
    {
      "taskId": "task_99",
      "explanation": "Created user controller",
      "fileDiffs": [
        {
          "path": "src/userController.ts",
          "content": "export const getUser = () => {};",
          "action": "CREATE"
        }
      ],
      "microTasks": ["Step 1", "Step 2"]
    }
    \`\`\``;

    const parsed = parseAgentJsonResponse('fallback_id', rawLlmOutput);
    assert.equal(parsed.taskId, 'task_99');
    assert.equal(parsed.explanation, 'Created user controller');
    assert.equal(parsed.fileDiffs.length, 1);
    assert.equal(parsed.fileDiffs[0].path, 'src/userController.ts');
    assert.deepEqual(parsed.microTasks, ['Step 1', 'Step 2']);
  });

  it('buildAgentUserPrompt includes contextFiles and self-healing errorLog stack trace', () => {
    const promptText = buildAgentUserPrompt('EXECUTE', {
      taskId: 'task_42',
      prompt: 'Fix null pointer in login.ts',
      contextFiles: [
        { path: 'src/login.ts', content: 'export const login = null;' },
      ],
      errorLog: 'TypeError: login is not a function at test.ts:12',
    });

    assert.ok(promptText.includes('MODE: EXECUTE'));
    assert.ok(promptText.includes('--- FILE: src/login.ts ---'));
    assert.ok(
      promptText.includes('TypeError: login is not a function at test.ts:12')
    );
  });

  it('Claude, AntiGravity, and Codex adapters support dry-run execution when API keys are omitted', async () => {
    const claude = new ClaudeAgentAdapter('claude-3-7-sonnet', undefined);
    const antigravity = new AntiGravityAgentAdapter('antigravity', undefined);
    const codex = new CodexAgentAdapter('codex', undefined);

    const planRes = await claude.plan({
      taskId: 't1',
      prompt: 'Build feature X',
    });
    assert.deepEqual(planRes.microTasks, ['Build feature X']);

    const execRes = await antigravity.execute({
      taskId: 't1',
      prompt: 'Build feature X',
    });
    assert.equal(execRes.taskId, 't1');

    const reviewRes = await codex.review(
      { taskId: 't1', prompt: 'Build feature X' },
      []
    );
    assert.equal(reviewRes.approved, true);
  });
});

