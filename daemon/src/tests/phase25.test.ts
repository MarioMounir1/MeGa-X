import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initMegaXProject, runMegaXCli } from '../cli';
import { MobileRelayServer } from '../relay/mobileRelayServer';

describe('Phase 25: MeGa X Doctor Readiness Check & Web Console Controls', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase25-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('megax doctor verifies Node, Git, config schema, and tunnel endpoints', async () => {
    const cfgPath = initMegaXProject(tempDir, 'Doctor-Test-Project');
    const res = await runMegaXCli(['doctor', '--config', cfgPath]);

    assert.equal(res.exitCode, 0);
    assert.ok(res.output.includes('=== MeGa X System Readiness Doctor ==='));
    assert.ok(res.output.includes('Doctor-Test-Project'));
    assert.ok(res.output.includes('git version'));
  });

  it('Web Steering Wheel HTML includes live mode switcher and Abort & Rollback controls', () => {
    const html = MobileRelayServer.renderWebSteeringWheelHtml();
    assert.ok(html.includes('SET_ENGINE_MODE'));
    assert.ok(html.includes('ABORT_TASK'));
    assert.ok(html.includes('Abort & Rollback'));
  });
});

