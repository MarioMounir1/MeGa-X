import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import { runMegaXCli } from '../cli';
import { bootstrapDaemon } from '../index';
import { MobileRelayServer } from '../relay/mobileRelayServer';
import { ReleaseNotesGenerator } from '../git/releaseNotes';

describe('Phase 64: Automated Semantic Release Notes & Changelog Generator', () => {
  it('categorizes commits and generates formatted markdown release notes', () => {
    const engine = bootstrapDaemon();
    const generator = new ReleaseNotesGenerator(engine.getGitManager());
    const categorized = generator.categorizeCommits(20);

    assert.ok(Array.isArray(categorized.features));
    assert.ok(Array.isArray(categorized.fixes));
    assert.ok(Array.isArray(categorized.maintenance));
    assert.ok(Array.isArray(categorized.tests));

    const markdown = generator.generateMarkdown({ version: 'v1.0.0' });
    assert.ok(markdown.includes('# Release Notes for MeGa X v1.0.0'));
    assert.ok(markdown.includes('### 🚀 Features & Subsystems'));
  });

  it('serves release notes via GET /api/release/notes in Markdown and JSON', async () => {
    const engine = bootstrapDaemon();
    const relay = new MobileRelayServer(engine, async () => {});
    const port = await relay.start(0, '127.0.0.1');

    try {
      // 1. Markdown test
      const mdResponse = await new Promise<string>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/api/release/notes?version=v1.2.0`, (res) => {
            assert.strictEqual(res.statusCode, 200);
            assert.ok(res.headers['content-type']?.includes('text/markdown'));
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          })
          .on('error', reject);
      });
      assert.ok(mdResponse.includes('# Release Notes for MeGa X v1.2.0'));

      // 2. JSON test
      const jsonResponse = await new Promise<string>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/api/release/notes?format=json`, (res) => {
            assert.strictEqual(res.statusCode, 200);
            assert.ok(res.headers['content-type']?.includes('application/json'));
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          })
          .on('error', reject);
      });
      const parsed = JSON.parse(jsonResponse);
      assert.strictEqual(parsed.version, 'v1.0.0');
      assert.ok(Array.isArray(parsed.features));
    } finally {
      await relay.stop();
    }
  });

  it('executes megax notes CLI command and outputs formatted notes', async () => {
    const { exitCode, output } = await runMegaXCli(['notes', '--version', 'v3.0.0']);
    assert.strictEqual(exitCode, 0);
    assert.ok(output.includes('# Release Notes for MeGa X v3.0.0'));
    assert.ok(output.includes('### 🚀 Features & Subsystems'));
  });
});
