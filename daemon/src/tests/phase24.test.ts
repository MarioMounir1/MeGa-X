import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FilePatcher, PatchSecurityError } from '../patcher/filePatcher';

describe('Phase 24: FilePatcher Payload Size & Batch Pre-Validation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase24-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('Rejects oversized FileDiff payloads and blank file paths atomically before touching disk', () => {
    // Max 64 bytes per file for test
    const patcher = new FilePatcher(tempDir, 64);

    assert.throws(
      () =>
        patcher.applyDiffs([
          { path: '   ', content: 'x', action: 'CREATE' },
        ]),
      PatchSecurityError
    );

    assert.throws(
      () =>
        patcher.applyDiffs([
          {
            path: 'valid_first.ts',
            content: 'const ok = 1;',
            action: 'CREATE',
          },
          {
            path: 'huge_second.ts',
            content: 'A'.repeat(200),
            action: 'CREATE',
          },
        ]),
      /exceeds max allowed size/
    );

    // Ensure atomic pre-validation prevented valid_first.ts from being written when huge_second.ts failed
    assert.equal(fs.existsSync(path.join(tempDir, 'valid_first.ts')), false);
  });
});

