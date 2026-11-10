import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VerificationRunner } from '../verifier/verificationRunner';

describe('Phase 22: Hung-Process Watchdog Timeout for Self-Healing Infinite Loops', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase22-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('VerificationRunner watchdog terminates hung commands with exitCode 124 and records timeout in errorLog', async () => {
    const runner = new VerificationRunner(
      tempDir,
      {
        compileCommand: 'node -e "setInterval(() => {}, 1000)"',
        testCommand: 'node -e "process.exit(0)"',
        maxFixAttempts: 3,
      },
      undefined,
      200 // 200ms watchdog timeout
    );

    const result = await runner.runVerificationSuite('task_hung_loop', 1);

    assert.equal(result.passed, false);
    assert.equal(result.compileResult.exitCode, 124);
    assert.ok(result.errorLog);
    assert.ok(result.errorLog.includes('[Watchdog Timeout]'));
    assert.ok(result.errorLog.includes('exceeded 200ms limit'));
  });
});
