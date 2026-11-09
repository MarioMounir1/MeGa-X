import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initMegaXProject, runMegaXCli } from '../cli';
import { loadMegaXConfig } from '../config/configLoader';

describe('Phase 11: MeGa X Developer CLI & Project Scaffolder', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase11-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('megax init scaffolds a valid megax.config.json in a target directory', async () => {
    const res = await runMegaXCli(['init', tempDir]);
    assert.equal(res.exitCode, 0);

    const configPath = path.join(tempDir, 'megax.config.json');
    assert.equal(fs.existsSync(configPath), true);

    const parsed = loadMegaXConfig(configPath);
    assert.equal(parsed.engineMode, 'SINGLE_AGENT');
    assert.equal(parsed.primaryAgent, 'claude-3-7-sonnet');
  });

  it('megax status and megax --help return structured CLI output', async () => {
    const configPath = initMegaXProject(tempDir, 'My-CLI-App');

    const helpRes = await runMegaXCli(['--help']);
    assert.equal(helpRes.exitCode, 0);
    assert.ok(helpRes.output.includes('MeGa X CLI'));

    const statusRes = await runMegaXCli(['status', '--config', configPath]);
    assert.equal(statusRes.exitCode, 0);
    assert.ok(statusRes.output.includes('My-CLI-App'));
    assert.ok(statusRes.output.includes('SINGLE_AGENT'));
  });
});

