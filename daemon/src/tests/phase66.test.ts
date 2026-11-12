import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runMegaXCli } from '../cli';
import { bootstrapDaemon } from '../index';
import { WorkspaceStateStore } from '../storage/workspaceStateStore';
import { MobileRelayServer } from '../relay/mobileRelayServer';

describe('Phase 66: Persistent Workspace Key-Value Config & State Store', () => {
  it('manages atomic state in an isolated directory with get, set, delete, and clear', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-state-test-'));
    try {
      const store = new WorkspaceStateStore(tempDir);
      assert.strictEqual(store.get('missingKey', 'defaultVal'), 'defaultVal');
      assert.strictEqual(store.has('activeFeature'), false);

      store.set('activeFeature', 'phase-66');
      store.set('retryCount', 3);
      store.setMultiple({ env: 'staging', debug: true });

      assert.strictEqual(store.has('activeFeature'), true);
      assert.strictEqual(store.get('activeFeature'), 'phase-66');
      assert.strictEqual(store.get('retryCount'), 3);
      assert.strictEqual(store.get('env'), 'staging');
      assert.strictEqual(store.get('debug'), true);

      const all = store.getAll();
      assert.strictEqual(Object.keys(all).length, 4);

      const deleted = store.delete('retryCount');
      assert.strictEqual(deleted, true);
      assert.strictEqual(store.has('retryCount'), false);

      store.clear();
      assert.strictEqual(Object.keys(store.getAll()).length, 0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('serves workspace state via REST endpoints (/api/state and /api/state/delete)', async () => {
    const engine = bootstrapDaemon();
    const store = engine.getStateStore();
    store.clear();
    store.set('relayMode', 'lan-direct');

    const relay = new MobileRelayServer(engine, async () => {});
    const port = await relay.start(0, '127.0.0.1');

    try {
      // 1. GET /api/state?key=relayMode
      const getKeyRes = await new Promise<string>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/api/state?key=relayMode`, (res) => {
            assert.strictEqual(res.statusCode, 200);
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          })
          .on('error', reject);
      });
      const parsedKey = JSON.parse(getKeyRes);
      assert.strictEqual(parsedKey.key, 'relayMode');
      assert.strictEqual(parsedKey.value, 'lan-direct');
      assert.strictEqual(parsedKey.exists, true);

      // 2. POST /api/state
      const postStateRes = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${port}/api/state`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' } },
          (res) => {
            assert.strictEqual(res.statusCode, 200);
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          }
        );
        req.on('error', reject);
        req.write(JSON.stringify({ key: 'clientApp', value: 'flutter-v2' }));
        req.end();
      });
      const parsedPost = JSON.parse(postStateRes);
      assert.strictEqual(parsedPost.success, true);
      assert.strictEqual(parsedPost.state.clientApp, 'flutter-v2');

      // 3. POST /api/state/delete
      const delStateRes = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${port}/api/state/delete`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' } },
          (res) => {
            assert.strictEqual(res.statusCode, 200);
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          }
        );
        req.on('error', reject);
        req.write(JSON.stringify({ key: 'clientApp' }));
        req.end();
      });
      const parsedDel = JSON.parse(delStateRes);
      assert.strictEqual(parsedDel.success, true);
      assert.strictEqual(parsedDel.deletedKey, 'clientApp');
    } finally {
      await relay.stop();
    }
  });

  it('runs megax state CLI commands (set, get, list, clear)', async () => {
    // 1. set
    const setRes = await runMegaXCli(['state', 'set', 'cliTestKey', 'testValue123']);
    assert.strictEqual(setRes.exitCode, 0);
    assert.ok(setRes.output.includes('cliTestKey'));

    // 2. get
    const getRes = await runMegaXCli(['state', 'get', 'cliTestKey']);
    assert.strictEqual(getRes.exitCode, 0);
    assert.ok(getRes.output.includes('testValue123'));

    // 3. list
    const listRes = await runMegaXCli(['state', 'list']);
    assert.strictEqual(listRes.exitCode, 0);
    assert.ok(listRes.output.includes('=== MeGa X Workspace State'));

    // 4. clear
    const clearRes = await runMegaXCli(['state', 'clear']);
    assert.strictEqual(clearRes.exitCode, 0);
    assert.ok(clearRes.output.includes('Cleared workspace state'));
  });
});
