import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateDockerEnvironment } from '../container/dockerConfigValidator';
import { runMegaXCli } from '../cli';

describe('Phase 51: Production Docker Containerization, Multi-Stage Build & Compose Stack', () => {
  const rootDir = path.resolve(__dirname, '..', '..', '..');

  it('validates production Dockerfile and docker-compose.yml at workspace root', () => {
    const report = validateDockerEnvironment(rootDir);

    assert.strictEqual(report.valid, true, `Expected valid docker environment, errors: ${report.errors.join('; ')}`);
    assert.strictEqual(report.dockerfile.exists, true);
    assert.strictEqual(report.dockerfile.isMultiStage, true);
    assert.strictEqual(report.dockerfile.hasGitInstalled, true);
    assert.strictEqual(report.dockerfile.hasCurlHealthcheck, true);
    assert.strictEqual(report.dockerfile.exposedPort, 4040);

    assert.strictEqual(report.compose.exists, true);
    assert.strictEqual(report.compose.hasDaemonService, true);
    assert.strictEqual(report.compose.hasPortMapping, true);
    assert.strictEqual(report.compose.hasWorkspaceVolume, true);
    assert.strictEqual(report.compose.hasHealthcheck, true);
    assert.strictEqual(report.errors.length, 0);
  });

  it('executes megax docker via CLI and reports structured readiness status', async () => {
    const cliResult = await runMegaXCli(['docker', '--root', rootDir]);
    assert.strictEqual(cliResult.exitCode, 0);
    assert.match(cliResult.output, /=== MeGa X Docker Readiness Check ===/);
    assert.match(cliResult.output, /Valid\s+:\s+YES/);
    assert.match(cliResult.output, /MultiStage=true/);
    assert.match(cliResult.output, /DaemonService=true/);
  });

  it('detects missing Docker configuration and invalid configurations in arbitrary directory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-docker-test-'));
    try {
      // Empty directory
      const emptyReport = validateDockerEnvironment(tempDir);
      assert.strictEqual(emptyReport.valid, false);
      assert.strictEqual(emptyReport.dockerfile.exists, false);
      assert.strictEqual(emptyReport.compose.exists, false);
      assert.ok(emptyReport.errors.length >= 2);

      // Deficient Dockerfile (no multi-stage, wrong port, no healthcheck)
      const fakeDockerfile = [
        'FROM node:20',
        'WORKDIR /app',
        'EXPOSE 8080',
        'CMD ["node", "app.js"]',
      ].join('\n');
      fs.writeFileSync(path.join(tempDir, 'Dockerfile'), fakeDockerfile, 'utf-8');

      const deficientReport = validateDockerEnvironment(tempDir);
      assert.strictEqual(deficientReport.valid, false);
      assert.strictEqual(deficientReport.dockerfile.isMultiStage, false);
      assert.strictEqual(deficientReport.dockerfile.exposedPort, 8080);
      assert.ok(deficientReport.errors.some((e) => e.includes('multi-stage')));
      assert.ok(deficientReport.errors.some((e) => e.includes('port 4040')));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
