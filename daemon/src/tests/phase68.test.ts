import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import { runMegaXCli } from '../cli';
import { bootstrapDaemon } from '../index';
import { ThoughtTraceRecorder } from '../agents/thoughtTraceRecorder';
import { MobileRelayServer } from '../relay/mobileRelayServer';

describe('Phase 68: Agent Thought Trace & Chain-of-Thought Telemetry Recorder', () => {
  it('records reasoning steps, assigns sequential indices, and calculates summary', () => {
    const recorder = new ThoughtTraceRecorder();

    const step1 = recorder.recordStep({
      taskId: 'task_reasoning_1',
      agentId: 'claude-3-7-sonnet',
      category: 'PLANNING',
      content: 'Decomposing authentication workflow into microtasks',
    });

    assert.strictEqual(step1.stepIndex, 1);
    assert.strictEqual(step1.category, 'PLANNING');

    const step2 = recorder.recordStep({
      taskId: 'task_reasoning_1',
      agentId: 'antigravity',
      category: 'ANALYSIS',
      content: 'Scanning existing jwt verification utilities',
    });

    assert.strictEqual(step2.stepIndex, 2);

    const summary = recorder.getTrace('task_reasoning_1');
    assert.strictEqual(summary.totalSteps, 2);
    assert.strictEqual(summary.agentsInvolved.length, 2);
    assert.ok(summary.agentsInvolved.includes('claude-3-7-sonnet'));
    assert.ok(summary.agentsInvolved.includes('antigravity'));

    assert.strictEqual(recorder.listActiveTaskTraces().length, 1);
    recorder.clearTrace('task_reasoning_1');
    assert.strictEqual(recorder.listActiveTaskTraces().length, 0);
  });

  it('serves thought traces via REST endpoints (/api/thoughts and /api/thoughts/clear)', async () => {
    const engine = bootstrapDaemon();
    const recorder = engine.getThoughtTraceRecorder();
    recorder.clearAll();

    const relay = new MobileRelayServer(engine, async () => {});
    const port = await relay.start(0, '127.0.0.1');

    try {
      // 1. POST /api/thoughts
      const postRes = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${port}/api/thoughts`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' } },
          (res) => {
            assert.strictEqual(res.statusCode, 200);
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          }
        );
        req.on('error', reject);
        req.write(
          JSON.stringify({
            taskId: 'task_rest_trace',
            agentId: 'codex',
            category: 'DECISION',
            content: 'Selected argon2 over bcrypt for key hashing',
          })
        );
        req.end();
      });
      const parsedPost = JSON.parse(postRes);
      assert.strictEqual(parsedPost.success, true);
      assert.strictEqual(parsedPost.step.category, 'DECISION');

      // 2. GET /api/thoughts?taskId=task_rest_trace
      const getRes = await new Promise<string>((resolve, reject) => {
        http
          .get(
            `http://127.0.0.1:${port}/api/thoughts?taskId=task_rest_trace`,
            (res) => {
              assert.strictEqual(res.statusCode, 200);
              let body = '';
              res.on('data', (c) => (body += c));
              res.on('end', () => resolve(body));
            }
          )
          .on('error', reject);
      });
      const parsedGet = JSON.parse(getRes);
      assert.strictEqual(parsedGet.totalSteps, 1);
      assert.strictEqual(parsedGet.steps[0].agentId, 'codex');

      // 3. POST /api/thoughts/clear
      const clearRes = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${port}/api/thoughts/clear`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' } },
          (res) => {
            assert.strictEqual(res.statusCode, 200);
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          }
        );
        req.on('error', reject);
        req.write(JSON.stringify({ taskId: 'task_rest_trace' }));
        req.end();
      });
      const parsedClear = JSON.parse(clearRes);
      assert.strictEqual(parsedClear.success, true);
    } finally {
      await relay.stop();
    }
  });

  it('runs megax trace CLI command and displays structured reasoning output', async () => {
    const engine = bootstrapDaemon();
    engine.getThoughtTraceRecorder().recordStep({
      taskId: 'cli_task_trace',
      agentId: 'claude-3-7-sonnet',
      category: 'VERIFICATION',
      content: 'All compile and test commands exited cleanly',
    });

    const { exitCode, output } = await runMegaXCli(['trace', 'cli_task_trace']);
    assert.strictEqual(exitCode, 0);
    assert.ok(output.includes('=== MeGa X Thought Trace: cli_task_trace'));
    assert.ok(output.includes('[VERIFICATION] [claude-3-7-sonnet]'));
  });
});

