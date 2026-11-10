import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getEnvDiagnostics } from '../config/envConfig';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { MobileRelayServer } from '../relay/mobileRelayServer';
import { MegaXConfig } from '../types/contracts';

describe('Phase 19: Redacted Environment Diagnostics & Container Readiness', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase19-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('getEnvDiagnostics reports configured provider booleans without leaking raw API keys', () => {
    const mockEnv: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: 'sk-ant-super-secret',
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: 'AIza-secret-gemini',
      MEGAX_RELAY_TOKEN: 'my-secret-token',
      MEGAX_PORT: '5050',
    };

    const diag = getEnvDiagnostics(mockEnv);
    assert.equal(diag.port, 5050);
    assert.equal(diag.providersConfigured.anthropicClaude, true);
    assert.equal(diag.providersConfigured.openaiCodex, false);
    assert.equal(diag.providersConfigured.geminiAntiGravity, true);
    assert.equal(diag.relaySecurity.tokenAuthEnabled, true);

    const serialized = JSON.stringify(diag);
    assert.equal(serialized.includes('sk-ant-super-secret'), false);
    assert.equal(serialized.includes('AIza-secret-gemini'), false);
    assert.equal(serialized.includes('my-secret-token'), false);
  });

  it('GET /api/diagnostics returns redacted provider status from MobileRelayServer', async () => {
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

    const engine = new OrchestratorEngine({ workspaceRoot: tempDir, config });
    const relay = new MobileRelayServer(engine);
    const port = await relay.start(0, '127.0.0.1');

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        providersConfigured: { anthropicClaude: boolean };
      };
      assert.equal(typeof body.providersConfigured.anthropicClaude, 'boolean');
    } finally {
      await relay.stop();
    }
  });
});

