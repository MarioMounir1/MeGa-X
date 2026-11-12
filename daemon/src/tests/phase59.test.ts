import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { execSync } from 'child_process';
import { GitManager } from '../git/gitManager';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { MobileRelayServer } from '../relay/mobileRelayServer';

describe('Phase 59: Workspace Git Semantic Tagging & Release Publisher', () => {
  it('creates, lists, and deletes annotated semantic release tags', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-tag-test-'));

    try {
      execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' });
      execSync('git config user.name "Tester"', { cwd: tempDir, stdio: 'ignore' });
      execSync('git config user.email "tester@megax.local"', { cwd: tempDir, stdio: 'ignore' });

      fs.writeFileSync(path.join(tempDir, 'release.txt'), 'version 1.0\n');
      execSync('git add . && git commit -m "initial release"', { cwd: tempDir, stdio: 'ignore' });

      const git = new GitManager(tempDir);

      // Create tag v1.0.0
      const tagResult = git.createReleaseTag('v1.0.0', 'Production Release v1.0.0');
      assert.strictEqual(tagResult.tag, 'v1.0.0');
      assert.ok(tagResult.commitHash);

      // List tags
      const tags = git.listReleaseTags();
      assert.strictEqual(tags.length, 1);
      assert.strictEqual(tags[0].tag, 'v1.0.0');
      assert.strictEqual(tags[0].message, 'Production Release v1.0.0');

      // Create tag v1.1.0
      fs.writeFileSync(path.join(tempDir, 'release.txt'), 'version 1.1\n');
      git.commitAll('v1.1 update');
      git.createReleaseTag('v1.1.0', 'Minor update v1.1.0');

      const updatedTags = git.listReleaseTags();
      assert.strictEqual(updatedTags.length, 2);
      assert.ok(updatedTags.some((t) => t.tag === 'v1.1.0'));
      assert.ok(updatedTags.some((t) => t.tag === 'v1.0.0'));

      // Delete tag v1.0.0
      const delResult = git.deleteReleaseTag('v1.0.0');
      assert.strictEqual(delResult.tag, 'v1.0.0');
      assert.strictEqual(delResult.deleted, true);

      const afterDelete = git.listReleaseTags();
      assert.strictEqual(afterDelete.length, 1);
      assert.strictEqual(afterDelete[0].tag, 'v1.1.0');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects empty tag names', () => {
    const git = new GitManager(process.cwd());
    assert.throws(() => git.createReleaseTag('  '), /Tag name cannot be empty/);
    assert.throws(() => git.deleteReleaseTag(''), /Tag name cannot be empty/);
  });

  it('exposes tag management via GET /api/tags, POST /api/tags, and POST /api/tags/delete', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-tag-api-'));

    try {
      execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' });
      execSync('git config user.name "Tester"', { cwd: tempDir, stdio: 'ignore' });
      execSync('git config user.email "tester@megax.local"', { cwd: tempDir, stdio: 'ignore' });
      fs.writeFileSync(path.join(tempDir, 'file.txt'), 'content\n');
      execSync('git add . && git commit -m "init"', { cwd: tempDir, stdio: 'ignore' });

      const engine = new OrchestratorEngine({
        workspaceRoot: tempDir,
        config: {
          projectName: 'Tag-API',
          engineMode: 'SINGLE_AGENT',
          primaryAgent: 'claude-3-7-sonnet',
          multiAgentConfig: {
            planner: 'claude-3-7-sonnet',
            executor: 'antigravity',
            reviewer: 'codex',
          },
          verification: { testCommand: '', compileCommand: '', maxFixAttempts: 1 },
          security: { requireApprovalOn: [] },
        },
      });

      const relay = new MobileRelayServer(engine);
      const port = await relay.start(0);

      try {
        // 1. POST /api/tags
        const createRes = await new Promise<any>((resolve, reject) => {
          const req = http.request(
            `http://localhost:${port}/api/tags`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' } },
            (r) => {
              let data = '';
              r.on('data', (c) => (data += c));
              r.on('end', () => resolve(JSON.parse(data)));
            }
          );
          req.on('error', reject);
          req.write(JSON.stringify({ tag: 'v2.0.0', message: 'Grand release' }));
          req.end();
        });
        assert.strictEqual(createRes.tag, 'v2.0.0');

        // 2. GET /api/tags
        const listRes = await new Promise<any>((resolve, reject) => {
          http.get(`http://localhost:${port}/api/tags`, (r) => {
            let data = '';
            r.on('data', (c) => (data += c));
            r.on('end', () => resolve(JSON.parse(data)));
          }).on('error', reject);
        });
        assert.strictEqual(listRes.totalCount, 1);
        assert.strictEqual(listRes.tags[0].tag, 'v2.0.0');

        // 3. POST /api/tags/delete
        const delRes = await new Promise<any>((resolve, reject) => {
          const req = http.request(
            `http://localhost:${port}/api/tags/delete`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' } },
            (r) => {
              let data = '';
              r.on('data', (c) => (data += c));
              r.on('end', () => resolve(JSON.parse(data)));
            }
          );
          req.on('error', reject);
          req.write(JSON.stringify({ tag: 'v2.0.0' }));
          req.end();
        });
        assert.strictEqual(delRes.deleted, true);
      } finally {
        await relay.stop();
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
