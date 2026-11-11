import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'node:test';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { MobileRelayServer } from '../relay/mobileRelayServer';
import { MegaXConfig } from '../types/contracts';

function createTestConfig(): MegaXConfig {
  return {
    projectName: 'Phase44-Verify-Test',
    engineMode: 'SINGLE_AGENT',
    primaryAgent: 'claude-3-7-sonnet',
    multiAgentConfig: {
      planner: 'claude-3-7-sonnet',
      executor: 'antigravity',
      reviewer: 'codex',
    },
    verification: {
      compileCommand: 'node -e "process.exit(0)"',
      testCommand: 'node -e "process.exit(0)"',
      maxFixAttempts: 1,
    },
    security: {
      requireApprovalOn: ['FILE_DELETE', 'DB_MIGRATION', 'MAX_RETRY_EXCEEDED'],
    },
  };
}

function httpPostJson(
  url: string,
  payload?: Record<string, unknown>
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyStr = payload ? JSON.stringify(payload) : undefined;
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: bodyStr
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(bodyStr),
            }
          : undefined,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => {
          raw += chunk.toString('utf-8');
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: JSON.parse(raw) as Record<string, unknown>,
          });
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

describe('Phase 44: Parametric Verification Runner & Custom Override API (/api/verify)', () => {
  it('executes custom compileCommand and testCommand overrides via POST /api/verify', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-p44-'));
    let relay: MobileRelayServer | undefined;

    try {
      const engine = new OrchestratorEngine({
        workspaceRoot: tempDir,
        config: createTestConfig(),
      });

      relay = new MobileRelayServer(engine, undefined, '');
      const port = await relay.start(0);

      // 1. Default verification without payload
      const defaultRes = await httpPostJson(
        `http://127.0.0.1:${port}/api/verify`
      );
      assert.strictEqual(defaultRes.statusCode, 200);
      assert.strictEqual(defaultRes.body.passed, true);

      // 2. Custom compileCommand override that succeeds
      const customPassRes = await httpPostJson(
        `http://127.0.0.1:${port}/api/verify`,
        {
          compileCommand: 'node -e "console.log(\'CustomCompileOK\')"',
          testCommand: 'node -e "console.log(\'CustomTestOK\')"',
        }
      );
      assert.strictEqual(customPassRes.statusCode, 200);
      assert.strictEqual(customPassRes.body.passed, true);
      const compRes = customPassRes.body.compileResult as { stdout: string };
      assert.ok(compRes.stdout.includes('CustomCompileOK'));

      // 3. Custom compileCommand override that fails and short-circuits
      const customFailRes = await httpPostJson(
        `http://127.0.0.1:${port}/api/verify`,
        {
          compileCommand: 'node -e "console.error(\'SyntaxCrash\'); process.exit(1)"',
        }
      );
      assert.strictEqual(customFailRes.statusCode, 200);
      assert.strictEqual(customFailRes.body.passed, false);
      assert.ok(String(customFailRes.body.errorLog).includes('SyntaxCrash'));

      // 4. Custom timeout override
      const customTimeoutRes = await httpPostJson(
        `http://127.0.0.1:${port}/api/verify`,
        {
          compileCommand: 'node -e "setTimeout(() => {}, 5000)"',
          timeoutMs: 150,
        }
      );
      assert.strictEqual(customTimeoutRes.statusCode, 200);
      assert.strictEqual(customTimeoutRes.body.passed, false);
      const timedOutComp = customTimeoutRes.body.compileResult as {
        exitCode: number;
        stderr: string;
      };
      assert.strictEqual(timedOutComp.exitCode, 124);
      assert.ok(timedOutComp.stderr.includes('Watchdog Timeout'));
    } finally {
      if (relay) {
        await relay.stop();
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

