import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SecurityGate } from '../security/securityGate';

describe('Phase 23: Protected Secret & Config File Guard in SecurityGate', () => {
  it('Detects and blocks AI attempts to modify .env, .git/config, SSH keys, or megax.config.json', async () => {
    const gate = new SecurityGate({
      requireApprovalOn: ['FILE_DELETE', 'DB_MIGRATION'],
    });

    const violations = gate.detectProtectedFileViolations([
      { path: '.env', content: 'OPENAI_API_KEY=leaked', action: 'UPDATE' },
      { path: '.env.production', content: 'SECRET=1', action: 'CREATE' },
      { path: '.git/config', content: 'malicious', action: 'UPDATE' },
      { path: 'megax.config.json', content: '{}', action: 'UPDATE' },
      { path: 'certs/server.pem', content: 'PRIVATE KEY', action: 'CREATE' },
      { path: '.env.example', content: 'SAFE_TEMPLATE=1', action: 'UPDATE' },
      { path: 'src/index.ts', content: 'export const ok = 1;', action: 'UPDATE' },
    ]);

    assert.deepEqual(violations, [
      '.env',
      '.env.production',
      '.git/config',
      'megax.config.json',
      'certs/server.pem',
    ]);

    const decision = await gate.verifyDiffsOrWait('task_tamper', [
      { path: '.env', content: 'HACKED=true', action: 'UPDATE' },
    ]);
    assert.equal(decision.approved, false);
    assert.ok(decision.note?.includes('Blocked by Protected File Guard'));
  });
});

