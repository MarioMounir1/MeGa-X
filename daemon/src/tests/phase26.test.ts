import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { MegaXConfig } from '../types/contracts';

describe('Phase 26: Dynamic Runtime Configuration Hot-Reloading', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase26-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('OrchestratorEngine.updateConfig hot-reloads security triggers and verification settings at runtime', () => {
    const initialConfig: MegaXConfig = {
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

    const engine = new OrchestratorEngine({
      workspaceRoot: tempDir,
      config: initialConfig,
    });

    assert.equal(engine.getSecurityGate().isTriggerEnabled('DB_MIGRATION'), false);

    // Hot-reload new config enabling DB_MIGRATION and updating maxFixAttempts to 5
    const reloaded = engine.updateConfig({
      ...initialConfig,
      engineMode: 'MULTI_AGENT',
      verification: {
        ...initialConfig.verification,
        maxFixAttempts: 5,
      },
      security: {
        requireApprovalOn: ['FILE_DELETE', 'DB_MIGRATION'],
      },
    });

    assert.equal(reloaded.engineMode, 'MULTI_AGENT');
    assert.equal(reloaded.verification.maxFixAttempts, 5);
    assert.equal(engine.getSecurityGate().isTriggerEnabled('DB_MIGRATION'), true);
  });
});

