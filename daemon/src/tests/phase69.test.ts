import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runMegaXCli } from '../cli';
import { bootstrapDaemon } from '../index';
import { WorkspaceCheckpointManager } from '../storage/checkpointManager';
import { MobileRelayServer } from '../relay/mobileRelayServer';

describe('Phase 69: Workspace Snapshot & Checkpoint Restoration Manager', () => {
  it('creates, lists, restores, and deletes checkpoints in an isolated workspace', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-chk-test-'));
    try {
      const sampleFile = path.join(tempDir, 'sample.txt');
      fs.writeFileSync(sampleFile, 'Original Content v1', 'utf-8');

      const cm = new WorkspaceCheckpointManager(tempDir, () => 'feature-spec');
      const chk1 = cm.createCheckpoint('v1-baseline', {
        files: ['sample.txt'],
        description: 'First baseline snapshot',
      });

      assert.strictEqual(chk1.name, 'v1-baseline');
      assert.strictEqual(chk1.branch, 'feature-spec');
      assert.strictEqual(chk1.fileCount, 1);

      // Modify the working file
      fs.writeFileSync(sampleFile, 'Corrupted Content v2', 'utf-8');
      assert.strictEqual(fs.readFileSync(sampleFile, 'utf-8'), 'Corrupted Content v2');

      // List checkpoints
      const list = cm.listCheckpoints();
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].id, chk1.id);

      // Restore checkpoint
      const restoreResult = cm.restoreCheckpoint(chk1.id);
      assert.strictEqual(restoreResult.success, true);
      assert.strictEqual(restoreResult.restoredFiles.length, 1);
      assert.strictEqual(fs.readFileSync(sampleFile, 'utf-8'), 'Original Content v1');

      // Delete checkpoint
      const deleted = cm.deleteCheckpoint(chk1.id);
      assert.strictEqual(deleted, true);
      assert.strictEqual(cm.listCheckpoints().length, 0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('serves checkpoints via REST endpoints (/api/checkpoints, restore, delete)', async () => {
    const engine = bootstrapDaemon();
    const relay = new MobileRelayServer(engine, async () => {});
    const port = await relay.start(0, '127.0.0.1');

    try {
      // 1. POST /api/checkpoints
      const postRes = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${port}/api/checkpoints`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' } },
          (res) => {
            assert.strictEqual(res.statusCode, 200);
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          }
        );
        req.on('error', reject);
        req.write(
          JSON.stringify({
            name: 'rest_chk_test',
            description: 'Automated REST checkpoint test',
          })
        );
        req.end();
      });
      const parsedPost = JSON.parse(postRes);
      assert.strictEqual(parsedPost.success, true);
      assert.strictEqual(parsedPost.checkpoint.name, 'rest_chk_test');
      const createdId = parsedPost.checkpoint.id;

      // 2. GET /api/checkpoints
      const getRes = await new Promise<string>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/api/checkpoints`, (res) => {
            assert.strictEqual(res.statusCode, 200);
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          })
          .on('error', reject);
      });
      const parsedGet = JSON.parse(getRes);
      assert.ok(parsedGet.count >= 1);
      assert.ok(parsedGet.checkpoints.some((c: { id: string }) => c.id === createdId));

      // 3. POST /api/checkpoints/restore
      const restoreRes = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${port}/api/checkpoints/restore`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' } },
          (res) => {
            assert.strictEqual(res.statusCode, 200);
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          }
        );
        req.on('error', reject);
        req.write(JSON.stringify({ id: createdId }));
        req.end();
      });
      const parsedRestore = JSON.parse(restoreRes);
      assert.strictEqual(parsedRestore.success, true);
      assert.strictEqual(parsedRestore.checkpointId, createdId);

      // 4. POST /api/checkpoints/delete
      const delRes = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${port}/api/checkpoints/delete`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' } },
          (res) => {
            assert.strictEqual(res.statusCode, 200);
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          }
        );
        req.on('error', reject);
        req.write(JSON.stringify({ id: createdId }));
        req.end();
      });
      const parsedDel = JSON.parse(delRes);
      assert.strictEqual(parsedDel.success, true);
    } finally {
      await relay.stop();
    }
  });

  it('runs megax checkpoint CLI commands (save, list, restore, del)', async () => {
    // 1. save
    const saveRes = await runMegaXCli(['checkpoint', 'save', 'cli_chk_1']);
    assert.strictEqual(saveRes.exitCode, 0);
    assert.ok(saveRes.output.includes('Created checkpoint "cli_chk_1"'));

    // Extract ID
    const match = saveRes.output.match(/\((chk_[^)]+)\)/);
    assert.ok(match && match[1]);
    const chkId = match[1];

    // 2. list
    const listRes = await runMegaXCli(['checkpoint', 'list']);
    assert.strictEqual(listRes.exitCode, 0);
    assert.ok(listRes.output.includes('=== MeGa X Workspace Checkpoints'));
    assert.ok(listRes.output.includes(chkId));

    // 3. restore
    const restoreRes = await runMegaXCli(['checkpoint', 'restore', chkId]);
    assert.strictEqual(restoreRes.exitCode, 0);
    assert.ok(restoreRes.output.includes(`Restored checkpoint ${chkId}`));

    // 4. del
    const delRes = await runMegaXCli(['checkpoint', 'del', chkId]);
    assert.strictEqual(delRes.exitCode, 0);
    assert.ok(delRes.output.includes(`Deleted checkpoint ${chkId}`));
  });
});

