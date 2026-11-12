import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'http';
import {
  AgentConsensusEngine,
  AgentVote,
} from '../orchestrator/consensusEngine';
import { FileDiff } from '../types/contracts';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { MobileRelayServer } from '../relay/mobileRelayServer';

describe('Phase 55: Multi-Agent Consensus & Conflict Resolution Engine', () => {
  it('evaluates unanimous approval when all agents approve without alternative proposals', () => {
    const engine = new AgentConsensusEngine();
    const originalDiffs: FileDiff[] = [
      { path: 'src/app.ts', content: 'export const app = true;', action: 'CREATE' },
    ];
    const votes: AgentVote[] = [
      { agentId: 'claude-3-7-sonnet', role: 'PLANNER', approved: true },
      { agentId: 'antigravity', role: 'EXECUTOR', approved: true },
      { agentId: 'codex', role: 'REVIEWER', approved: true },
    ];

    const result = engine.evaluateVotes('task_consensus_1', originalDiffs, votes);
    assert.strictEqual(result.status, 'UNANIMOUS_APPROVAL');
    assert.strictEqual(result.approvalRatio, 1.0);
    assert.strictEqual(result.conflictingFiles.length, 0);
    assert.strictEqual(result.requiresMobileEscalation, false);
    assert.strictEqual(result.resolutionStrategyApplied, 'DIRECT_PASS');
  });

  it('detects file conflict when Reviewer proposes contradictory alternative diff', () => {
    const engine = new AgentConsensusEngine();
    const originalDiffs: FileDiff[] = [
      { path: 'src/auth.ts', content: 'const token = "weak";', action: 'CREATE' },
    ];
    const votes: AgentVote[] = [
      { agentId: 'claude-3-7-sonnet', role: 'PLANNER', approved: true },
      { agentId: 'antigravity', role: 'EXECUTOR', approved: true },
      {
        agentId: 'codex',
        role: 'REVIEWER',
        approved: false,
        feedback: 'Insecure hardcoded token',
        proposedAlternativeDiffs: [
          { path: 'src/auth.ts', content: 'const token = process.env.TOKEN;', action: 'UPDATE' },
        ],
      },
    ];

    const result = engine.evaluateVotes('task_conflict_1', originalDiffs, votes);
    assert.strictEqual(result.status, 'CONFLICT_DETECTED');
    assert.deepStrictEqual(result.conflictingFiles, ['src/auth.ts']);
    assert.strictEqual(result.requiresMobileEscalation, true);
    assert.strictEqual(result.resolutionStrategyApplied, 'ESCALATED');
  });

  it('resolves conflicting diffs autonomously via synthesis callback', async () => {
    const engine = new AgentConsensusEngine();
    const originalDiffs: FileDiff[] = [
      { path: 'src/api.ts', content: 'export const port = 3000;', action: 'CREATE' },
    ];
    const votes: AgentVote[] = [
      { agentId: 'antigravity', role: 'EXECUTOR', approved: true },
      {
        agentId: 'codex',
        role: 'REVIEWER',
        approved: false,
        proposedAlternativeDiffs: [
          { path: 'src/api.ts', content: 'export const port = process.env.PORT || 3000;', action: 'UPDATE' },
        ],
      },
    ];

    const initial = engine.evaluateVotes('task_synth_1', originalDiffs, votes);
    assert.strictEqual(initial.status, 'CONFLICT_DETECTED');

    const resolved = await engine.resolveConflict(initial, async (conflict) => {
      // Synthesizer merges reviewer's env fallback
      return [
        {
          path: conflict.conflictingFiles[0],
          content: 'export const port = Number(process.env.PORT) || 3000;',
          action: 'UPDATE',
        },
      ];
    });

    assert.strictEqual(resolved.status, 'MAJORITY_APPROVAL');
    assert.strictEqual(resolved.resolutionStrategyApplied, 'SYNTHESIS');
    assert.strictEqual(resolved.requiresMobileEscalation, false);
    assert.ok(resolved.resolvedDiffs);
    assert.strictEqual(
      resolved.resolvedDiffs[0].content,
      'export const port = Number(process.env.PORT) || 3000;'
    );
  });

  it('exposes recent consensus evaluations via GET /api/consensus endpoint', async () => {
    const engine = new OrchestratorEngine({
      workspaceRoot: process.cwd(),
      config: {
        projectName: 'Consensus-Test',
        engineMode: 'MULTI_AGENT',
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

    engine.getConsensusEngine().evaluateVotes(
      'task_live_eval',
      [{ path: 'sample.ts', content: '// code', action: 'CREATE' }],
      [
        { agentId: 'claude-3-7-sonnet', role: 'PLANNER', approved: true },
        { agentId: 'antigravity', role: 'EXECUTOR', approved: true },
      ]
    );

    const relay = new MobileRelayServer(engine);
    const port = await relay.start(0);

    try {
      const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        http.get(`http://localhost:${port}/api/consensus`, (r) => {
          let data = '';
          r.on('data', (c) => (data += c));
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body: JSON.parse(data) }));
        }).on('error', reject);
      });

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.count >= 1);
      assert.strictEqual(res.body.evaluations[0].taskId, 'task_live_eval');
      assert.strictEqual(res.body.evaluations[0].status, 'UNANIMOUS_APPROVAL');
    } finally {
      await relay.stop();
    }
  });
});
