import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VerificationRunner } from '../verifier/verificationRunner';
import { TerminalStreamEvent } from '../types/contracts';

describe('Phase 3: Self-Healing Verification Runner', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase3-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('passes when both compileCommand and testCommand succeed and streams live terminal events', async () => {
    const streamEvents: TerminalStreamEvent[] = [];

    const runner = new VerificationRunner(
      tempDir,
      {
        compileCommand: 'node -e "console.log(\'Compile OK\')"',
        testCommand: 'node -e "console.log(\'Tests OK\')"',
        maxFixAttempts: 3,
      },
      (evt) => streamEvents.push(evt)
    );

    const result = await runner.runVerificationSuite('task-pass', 1);

    assert.equal(result.passed, true);
    assert.equal(result.attempt, 1);
    assert.equal(result.compileResult.exitCode, 0);
    assert.ok(result.compileResult.stdout.includes('Compile OK'));
    assert.equal(result.testResult?.exitCode, 0);
    assert.ok(result.testResult?.stdout.includes('Tests OK'));
    assert.equal(result.errorLog, undefined);

    // Ensure stdout and system events were streamed for Mobile Controller
    assert.ok(streamEvents.some((e) => e.stream === 'system'));
    assert.ok(
      streamEvents.some(
        (e) => e.stream === 'stdout' && e.data.includes('Compile OK')
      )
    );
  });

  it('short-circuits on compile failure and captures stderr into errorLog', async () => {
    const runner = new VerificationRunner(tempDir, {
      compileCommand:
        'node -e "console.error(\'TS2322: Type number is not assignable to string\'); process.exit(1)"',
      testCommand: 'node -e "console.log(\'Should not run\')"',
      maxFixAttempts: 3,
    });

    const result = await runner.runVerificationSuite('task-compile-fail', 1);

    assert.equal(result.passed, false);
    assert.equal(result.compileResult.passed, false);
    assert.equal(result.testResult, undefined);
    assert.ok(result.errorLog);
    assert.ok(result.errorLog.includes('COMPILE_STEP FAILED on Attempt 1/3'));
    assert.ok(
      result.errorLog.includes(
        'TS2322: Type number is not assignable to string'
      )
    );
  });

  it('captures stack trace into errorLog when compile succeeds but testCommand fails', async () => {
    const runner = new VerificationRunner(tempDir, {
      compileCommand: 'node -e "console.log(\'Compile OK\')"',
      testCommand:
        'node -e "console.error(\'AssertionError: expected 200 to equal 401 at auth.test.ts:42\'); process.exit(1)"',
      maxFixAttempts: 3,
    });

    const result = await runner.runVerificationSuite('task-test-fail', 2);

    assert.equal(result.passed, false);
    assert.equal(result.compileResult.passed, true);
    assert.equal(result.testResult?.passed, false);
    assert.ok(result.errorLog);
    assert.ok(result.errorLog.includes('TEST_STEP FAILED on Attempt 2/3'));
    assert.ok(
      result.errorLog.includes(
        'AssertionError: expected 200 to equal 401 at auth.test.ts:42'
      )
    );
  });
});

