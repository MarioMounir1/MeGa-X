import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'http';
import { BenchmarkRunner } from '../benchmark/benchmarkRunner';
import { runMegaXCli } from '../cli';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { MobileRelayServer } from '../relay/mobileRelayServer';

describe('Phase 56: Autonomous Benchmark Runner & Performance Profiler', () => {
  it('exposes built-in benchmark scenarios with expected outcomes', () => {
    const runner = new BenchmarkRunner();
    const scenarios = runner.getScenarios();

    assert.ok(scenarios.length >= 3);
    assert.ok(scenarios.some((s) => s.id === 'first_pass_nominal'));
    assert.ok(scenarios.some((s) => s.id === 'compiler_self_healing'));
    assert.ok(scenarios.some((s) => s.id === 'multi_agent_consensus'));
  });

  it('runs an individual scenario in an isolated workspace and measures metrics', async () => {
    const runner = new BenchmarkRunner();
    const scenario = runner.getScenarios().find((s) => s.id === 'first_pass_nominal')!;

    const result = await runner.runScenario(scenario);
    assert.strictEqual(result.scenarioId, 'first_pass_nominal');
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.actualOutcome, 'PASSED_FIRST_ATTEMPT');
    assert.ok(result.durationMs >= 0);
    assert.strictEqual(result.rollbacksTriggered, 0);
  });

  it('executes full suite and calculates aggregate pass rate and stability score', async () => {
    const runner = new BenchmarkRunner();
    // Run with single scenario to keep test duration swift
    const report = await runner.runSuite('first_pass_nominal');

    assert.strictEqual(report.totalScenarios, 1);
    assert.strictEqual(report.passedScenarios, 1);
    assert.strictEqual(report.passRatePercent, 100);
    assert.strictEqual(report.stabilityScore, 100);
    assert.ok(report.avgDurationMs >= 0);
    assert.strictEqual(report.results.length, 1);
  });

  it('runs megax benchmark command via CLI and formats summary table', async () => {
    const cliResult = await runMegaXCli(['benchmark', '--scenario', 'first_pass_nominal']);
    assert.strictEqual(cliResult.exitCode, 0);
    assert.match(cliResult.output, /=== MeGa X Autonomous Benchmark Report ===/);
    assert.match(cliResult.output, /Passed Scenarios: 1\/1 \(100%\)/);
    assert.match(cliResult.output, /Stability Score : 100\/100/);
    assert.match(cliResult.output, /\[PASS\] Nominal First-Attempt Verification/);
  });

  it('serves benchmark scenarios and runner via /api/benchmark REST endpoints', async () => {
    const engine = new OrchestratorEngine({
      workspaceRoot: process.cwd(),
      config: {
        projectName: 'Benchmark-API-Test',
        engineMode: 'SINGLE_AGENT',
        primaryAgent: 'claude-3-7-sonnet',
        multiAgentConfig: {
          planner: 'claude-3-7-sonnet',
          executor: 'antigravity',
          reviewer: 'codex',
        },
        verification: { testCommand: '', compileCommand: '', maxFixAttempts: 1 },
        security: { requireApprovalOn: [] },
      },
    });

    const relay = new MobileRelayServer(engine);
    const port = await relay.start(0);

    try {
      // 1. GET /api/benchmark/scenarios
      const scenarios = await new Promise<any[]>((resolve, reject) => {
        http.get(`http://localhost:${port}/api/benchmark/scenarios`, (r) => {
          let data = '';
          r.on('data', (c) => (data += c));
          r.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
      });
      assert.ok(Array.isArray(scenarios));
      assert.ok(scenarios.length >= 3);

      // 2. POST /api/benchmark/run
      const report = await new Promise<any>((resolve, reject) => {
        const req = http.request(
          `http://localhost:${port}/api/benchmark/run`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' } },
          (r) => {
            let data = '';
            r.on('data', (c) => (data += c));
            r.on('end', () => resolve(JSON.parse(data)));
          }
        );
        req.on('error', reject);
        req.write(JSON.stringify({ scenarioId: 'first_pass_nominal' }));
        req.end();
      });

      assert.strictEqual(report.totalScenarios, 1);
      assert.strictEqual(report.passedScenarios, 1);
      assert.strictEqual(report.passRatePercent, 100);
    } finally {
      await relay.stop();
    }
  });
});
