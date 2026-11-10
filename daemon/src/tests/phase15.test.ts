import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { MobileRelayServer } from '../relay/mobileRelayServer';
import { TerminalStreamThrottler } from '../relay/streamThrottler';
import { MegaXConfig, TerminalStreamEvent } from '../types/contracts';

describe('Phase 15: Non-Blocking Telemetry Stream Throttler & Scrollback Ring Buffer', () => {
  it('Coalesces rapid chunks, splits oversized payloads, and enforces ring buffer capacity', async () => {
    const flushed: TerminalStreamEvent[] = [];
    const throttler = new TerminalStreamThrottler(
      (evt) => flushed.push(evt),
      {
        flushIntervalMs: 30,
        maxChunkLength: 10,
        maxBufferEvents: 3,
      }
    );

    // Push 2 rapid chunks for the same stream -> should coalesce into "0123456789ABCDEF" (16 chars)
    throttler.push({
      taskId: 't1',
      stream: 'stdout',
      data: '01234567',
      attempt: 1,
      timestamp: '2026-11-10T00:00:00Z',
    });
    throttler.push({
      taskId: 't1',
      stream: 'stdout',
      data: '89ABCDEF',
      attempt: 1,
      timestamp: '2026-11-10T00:00:01Z',
    });

    await new Promise((r) => setTimeout(r, 60));

    // 16 chars split by maxChunkLength=10 -> 2 chunks ("0123456789" and "ABCDEF")
    assert.equal(flushed.length, 2);
    assert.equal(flushed[0].data, '0123456789');
    assert.equal(flushed[1].data, 'ABCDEF');

    // Push 2 more events to exceed maxBufferEvents=3
    throttler.push({
      taskId: 't1',
      stream: 'system',
      data: 'msg3',
      attempt: 1,
      timestamp: '2026-11-10T00:00:02Z',
    });
    throttler.push({
      taskId: 't1',
      stream: 'stderr',
      data: 'msg4',
      attempt: 1,
      timestamp: '2026-11-10T00:00:03Z',
    });
    throttler.flushNow();

    const recent = throttler.getRecentLogs();
    assert.equal(recent.length, 3);
    assert.equal(recent[0].data, 'ABCDEF');
    assert.equal(recent[2].data, 'msg4');
  });

  it('GET /api/logs returns buffered terminal scrollback from MobileRelayServer', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase15-'));
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
        compileCommand: 'node -e "console.log(\'ScrollbackTestLine\')"',
        testCommand: 'node -e "process.exit(0)"',
        maxFixAttempts: 3,
      },
      security: {
        requireApprovalOn: ['FILE_DELETE'],
      },
    };

    const engine = new OrchestratorEngine({ workspaceRoot: tempDir, config });
    const relay = new MobileRelayServer(engine);
    const port = await relay.start(0, '127.0.0.1');

    try {
      await engine.runFeaturePrompt('scroll_task', 'Run scrollback test');
      const res = await fetch(`http://127.0.0.1:${port}/api/logs`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { logs: TerminalStreamEvent[] };
      assert.ok(
        body.logs.some((l) => l.data.includes('ScrollbackTestLine'))
      );
    } finally {
      await relay.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

