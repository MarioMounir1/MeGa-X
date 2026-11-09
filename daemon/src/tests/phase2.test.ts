import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FilePatcher, PatchSecurityError } from '../patcher/filePatcher';
import { SecurityGate } from '../security/securityGate';
import { GitManager } from '../git/gitManager';
import { FileDiff } from '../types/contracts';

describe('Phase 2: Git Safety Net, File Patcher & Security Gate', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase2-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('FilePatcher applies CREATE, UPDATE, DELETE and blocks path traversal', () => {
    const patcher = new FilePatcher(tempDir);

    // 1. CREATE
    patcher.applyDiffs([
      {
        path: 'src/hello.ts',
        content: 'export const msg = "v1";',
        action: 'CREATE',
      },
    ]);
    assert.equal(
      fs.readFileSync(path.join(tempDir, 'src/hello.ts'), 'utf-8'),
      'export const msg = "v1";'
    );

    // 2. UPDATE
    patcher.applyDiffs([
      {
        path: 'src/hello.ts',
        content: 'export const msg = "v2";',
        action: 'UPDATE',
      },
    ]);
    const context = patcher.readContextFiles(['src/hello.ts']);
    assert.equal(context.length, 1);
    assert.equal(context[0].content, 'export const msg = "v2";');

    // 3. DELETE
    patcher.applyDiffs([
      {
        path: 'src/hello.ts',
        content: '',
        action: 'DELETE',
      },
    ]);
    assert.equal(fs.existsSync(path.join(tempDir, 'src/hello.ts')), false);

    // 4. Path Traversal Protection
    assert.throws(
      () =>
        patcher.applyDiffs([
          {
            path: '../../outside.txt',
            content: 'hacked',
            action: 'CREATE',
          },
        ]),
      PatchSecurityError
    );
  });

  it('SecurityGate detects FILE_DELETE and DB_MIGRATION and enforces approval', async () => {
    const gate = new SecurityGate({
      requireApprovalOn: ['DB_MIGRATION', 'FILE_DELETE', 'MAX_RETRY_EXCEEDED'],
    });

    const riskyDiffs: FileDiff[] = [
      {
        path: 'prisma/migrations/001_init.sql',
        content: 'CREATE TABLE users (id INT PRIMARY KEY);',
        action: 'CREATE',
      },
      {
        path: 'src/legacy.ts',
        content: '',
        action: 'DELETE',
      },
    ];

    const triggers = gate.detectDiffTriggers(riskyDiffs);
    assert.equal(triggers.length, 2);
    assert.equal(triggers[0].trigger, 'FILE_DELETE');
    assert.equal(triggers[1].trigger, 'DB_MIGRATION');

    // Without handler -> auto-rejects safely
    const deniedResult = await gate.verifyDiffsOrWait('task-101', riskyDiffs);
    assert.equal(deniedResult.approved, false);
    assert.equal(deniedResult.rejectedBy, 'FILE_DELETE');

    // With handler -> approves when mobile user approves
    gate.setApprovalHandler(async (req) => ({
      approvalId: req.approvalId,
      taskId: req.taskId,
      approved: true,
      userNote: 'Approved from Flutter Mobile App',
    }));

    const approvedResult = await gate.verifyDiffsOrWait('task-101', riskyDiffs);
    assert.equal(approvedResult.approved, true);
  });

  it('GitManager creates isolated megax/task-id branch, commits, and hard-rolls back broken code', () => {
    const git = new GitManager(tempDir);
    const patcher = new FilePatcher(tempDir);

    // Initialize repo and base commit
    git.runGit(['init']);
    git.runGit(['config', 'user.email', 'daemon@megax.local']);
    git.runGit(['config', 'user.name', 'MeGa X Daemon']);
    patcher.applyDiffs([
      { path: 'index.ts', content: 'export const base = 1;\n', action: 'CREATE' },
    ]);
    git.commitAll('chore: initial commit');
    const baseBranch = git.getCurrentBranch();

    // Create isolated task branch and commit passing work
    const taskBranch = git.createTaskBranch('task_01');
    assert.equal(taskBranch, 'megax/task_01');
    assert.equal(git.getCurrentBranch(), 'megax/task_01');

    patcher.applyDiffs([
      {
        path: 'feature.ts',
        content: 'export const feature = true;\n',
        action: 'CREATE',
      },
    ]);
    const commitHash = git.commitAll('feat: add feature.ts');
    assert.ok(commitHash);

    // Simulate a broken micro-task that exceeds max retries and must be rolled back
    const brokenBranch = git.createTaskBranch('task_02_broken');
    patcher.applyDiffs([
      {
        path: 'index.ts',
        content: 'BROKEN SYNTAX {{{',
        action: 'UPDATE',
      },
      {
        path: 'untracked_garbage.ts',
        content: 'temp error file',
        action: 'CREATE',
      },
    ]);

    // Execute hard rollback back to baseBranch and delete broken branch
    git.hardRollback({
      returnBranch: baseBranch,
      deleteTaskBranch: brokenBranch,
    });

    assert.equal(git.getCurrentBranch(), baseBranch);
    assert.equal(
      fs
        .readFileSync(path.join(tempDir, 'index.ts'), 'utf-8')
        .replace(/\r\n/g, '\n'),
      'export const base = 1;\n'
    );
    assert.equal(
      fs.existsSync(path.join(tempDir, 'untracked_garbage.ts')),
      false
    );
  });
});
