import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  loadMegaXConfig,
  validateMegaXConfig,
  ConfigValidationError,
} from '../config/configLoader';
import {
  AgentResponse,
  AgentTaskPayload,
  FileDiff,
} from '../types/contracts';

describe('Phase 1: Core Contracts & Config Loader', () => {
  it('loads and validates the root megax.config.json file', () => {
    const rootConfigPath = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'megax.config.json'
    );
    const config = loadMegaXConfig(rootConfigPath);

    assert.equal(config.projectName, 'Target-Project');
    assert.equal(config.engineMode, 'SINGLE_AGENT');
    assert.equal(config.primaryAgent, 'claude-3-7-sonnet');
    assert.deepEqual(config.multiAgentConfig, {
      planner: 'claude-3-7-sonnet',
      executor: 'antigravity',
      reviewer: 'codex',
    });
    assert.deepEqual(config.verification, {
      testCommand: 'npm test',
      compileCommand: 'npx tsc --noEmit',
      maxFixAttempts: 3,
    });
    assert.deepEqual(config.security.requireApprovalOn, [
      'DB_MIGRATION',
      'FILE_DELETE',
      'MAX_RETRY_EXCEEDED',
    ]);
  });

  it('rejects invalid engineMode or security triggers', () => {
    assert.throws(
      () =>
        validateMegaXConfig({
          projectName: 'Test',
          engineMode: 'INVALID_MODE',
          primaryAgent: 'claude-3-7-sonnet',
          multiAgentConfig: {
            planner: 'a',
            executor: 'b',
            reviewer: 'c',
          },
          verification: {
            testCommand: 'npm test',
            compileCommand: 'npx tsc --noEmit',
            maxFixAttempts: 3,
          },
          security: {
            requireApprovalOn: ['FILE_DELETE'],
          },
        }),
      ConfigValidationError
    );
  });

  it('conforms to FileDiff, AgentTaskPayload, and AgentResponse contracts', () => {
    const diff: FileDiff = {
      path: 'src/auth.ts',
      content: 'export const login = () => true;',
      action: 'CREATE',
    };

    const payload: AgentTaskPayload = {
      taskId: 'task-001',
      prompt: 'Implement login helper',
      contextFiles: [{ path: 'README.md', content: '# Target Project' }],
      errorLog: 'Error: test failed at line 4',
    };

    const response: AgentResponse = {
      taskId: payload.taskId,
      explanation: 'Created login module',
      fileDiffs: [diff],
      microTasks: ['Create src/auth.ts', 'Add unit tests'],
    };

    assert.equal(response.taskId, 'task-001');
    assert.equal(response.fileDiffs[0].action, 'CREATE');
    assert.equal(response.microTasks?.length, 2);
  });
});

