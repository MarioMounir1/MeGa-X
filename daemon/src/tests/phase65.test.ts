import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import { runMegaXCli } from '../cli';
import { bootstrapDaemon } from '../index';
import { TokenBudgetManager } from '../agents/tokenBudgetManager';
import { MobileRelayServer } from '../relay/mobileRelayServer';

describe('Phase 65: Token & Cost Budget Manager, REST Endpoints, and CLI Inspector', () => {
  it('records model token usage, computes estimated costs, and flags exceeded limits', () => {
    const budget = new TokenBudgetManager({ maxTotalTokens: 5000, maxCostUsd: 0.1 });

    const rec1 = budget.recordUsage({
      agentId: 'claude-3-7-sonnet',
      taskId: 'task_001',
      promptTokens: 1000,
      completionTokens: 500,
      latencyMs: 1200,
    });

    assert.strictEqual(rec1.agentId, 'claude-3-7-sonnet');
    assert.ok(rec1.estimatedCostUsd > 0);

    const summary1 = budget.getSummary();
    assert.strictEqual(summary1.totalPromptTokens, 1000);
    assert.strictEqual(summary1.totalCompletionTokens, 500);
    assert.strictEqual(summary1.totalTokens, 1500);
    assert.strictEqual(summary1.isBudgetExceeded, false);

    // Record an oversized usage that breaches token limits
    budget.recordUsage({
      agentId: 'antigravity',
      taskId: 'task_002',
      promptTokens: 4000,
      completionTokens: 1000,
      latencyMs: 1500,
    });

    const summary2 = budget.getSummary();
    assert.strictEqual(summary2.totalTokens, 6500);
    assert.strictEqual(summary2.isBudgetExceeded, true);
    assert.ok(summary2.exceededReason?.includes('Token limit'));
  });

  it('manages budget over REST endpoints (/api/budget, /api/budget/limits, /api/budget/reset)', async () => {
    const engine = bootstrapDaemon();
    const budget = engine.getBudgetManager();
    budget.reset();
    budget.recordUsage({
      agentId: 'codex',
      taskId: 'task_rest_1',
      promptTokens: 800,
      completionTokens: 200,
      latencyMs: 950,
    });

    const relay = new MobileRelayServer(engine, async () => {});
    const port = await relay.start(0, '127.0.0.1');

    try {
      // 1. GET /api/budget
      const getRes = await new Promise<string>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/api/budget`, (res) => {
            assert.strictEqual(res.statusCode, 200);
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          })
          .on('error', reject);
      });
      const getParsed = JSON.parse(getRes);
      assert.strictEqual(getParsed.summary.totalTokens, 1000);
      assert.strictEqual(getParsed.records.length, 1);

      // 2. POST /api/budget/limits
      const postLimitsRes = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${port}/api/budget/limits`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' } },
          (res) => {
            assert.strictEqual(res.statusCode, 200);
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          }
        );
        req.on('error', reject);
        req.write(JSON.stringify({ maxTotalTokens: 500 }));
        req.end();
      });
      const limitsParsed = JSON.parse(postLimitsRes);
      assert.strictEqual(limitsParsed.limits.maxTotalTokens, 500);
      assert.strictEqual(limitsParsed.isBudgetExceeded, true);

      // 3. POST /api/budget/reset
      const resetRes = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${port}/api/budget/reset`,
          { method: 'POST' },
          (res) => {
            assert.strictEqual(res.statusCode, 200);
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          }
        );
        req.on('error', reject);
        req.end();
      });
      const resetParsed = JSON.parse(resetRes);
      assert.strictEqual(resetParsed.success, true);
      assert.strictEqual(resetParsed.summary.totalTokens, 0);
    } finally {
      await relay.stop();
    }
  });

  it('runs megax budget CLI command and outputs structured summary', async () => {
    const { exitCode, output } = await runMegaXCli(['budget']);
    assert.strictEqual(exitCode, 0);
    assert.ok(output.includes('=== MeGa X Token & Cost Budget Summary ==='));
    assert.ok(output.includes('Total Tokens      :'));
    assert.ok(output.includes('Estimated Cost    : $'));
    assert.ok(output.includes('Budget Exceeded   : NO'));
  });
});

