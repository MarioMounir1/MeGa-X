import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'node:test';
import { runMegaXCli } from '../cli';
import { GitManager } from '../git/gitManager';

describe('Phase 45: Developer CLI Diagnostics & Verification Commands (megax verify & megax diff)', () => {
  it('executes megax verify and megax diff via CLI arguments', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-p45-'));

    try {
      const git = new GitManager(tempDir);
      git.runGit(['init', '-b', 'main']);
      git.runGit(['config', 'user.name', 'MeGa X CLI Test']);
      git.runGit(['config', 'user.email', 'cli@megax.local']);

      const configPath = path.join(tempDir, 'megax.config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify(
          {
            projectName: 'Phase45-CLI-Test',
            engineMode: 'SINGLE_AGENT',
            primaryAgent: 'claude-3-7-sonnet',
            multiAgentConfig: {
              planner: 'claude-3-7-sonnet',
              executor: 'antigravity',
              reviewer: 'codex',
            },
            verification: {
              compileCommand: 'node -e "console.log(\'CLICompileOK\')"',
              testCommand: 'node -e "console.log(\'CLITestOK\')"',
              maxFixAttempts: 1,
            },
            security: {
              requireApprovalOn: ['FILE_DELETE'],
            },
          },
          null,
          2
        ),
        'utf-8'
      );

      fs.writeFileSync(
        path.join(tempDir, 'app.ts'),
        'export const cli = true;\n',
        'utf-8'
      );
      git.commitAll('Initial commit');

      // 1. Run megax verify via CLI
      const verifyRes = await runMegaXCli([
        'verify',
        '--config',
        configPath,
      ]);
      assert.strictEqual(verifyRes.exitCode, 0);
      assert.ok(verifyRes.output.includes('Passed       : YES'));
      assert.ok(verifyRes.output.includes('Compile Step : PASSED'));
      assert.ok(verifyRes.output.includes('Test Step    : PASSED'));

      // 2. Run megax diff on clean tree
      const cleanDiffRes = await runMegaXCli([
        'diff',
        '--config',
        configPath,
      ]);
      assert.strictEqual(cleanDiffRes.exitCode, 0);
      assert.ok(cleanDiffRes.output.includes('Branch  : main'));
      assert.ok(cleanDiffRes.output.includes('No uncommitted changes.'));

      // 3. Dirty tree and run megax diff
      fs.writeFileSync(
        path.join(tempDir, 'app.ts'),
        'export const cli = false; // dirty\n',
        'utf-8'
      );
      const dirtyDiffRes = await runMegaXCli([
        'diff',
        '--config',
        configPath,
      ]);
      assert.strictEqual(dirtyDiffRes.exitCode, 0);
      assert.ok(dirtyDiffRes.output.includes('Diff:'));
      assert.ok(dirtyDiffRes.output.includes('dirty'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

