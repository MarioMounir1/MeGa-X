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
    projectName: 'Phase42-Search-Test',
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

function httpGetJson(
  url: string
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
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
      })
      .on('error', reject);
  });
}

describe('Phase 42: Workspace Code Content Search / Grep API (/api/search)', () => {
  it('searches workspace source files for matching lines and line numbers via GET /api/search', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-p42-'));
    let relay: MobileRelayServer | undefined;

    try {
      fs.mkdirSync(path.join(tempDir, 'src', 'auth'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'auth', 'jwt.ts'),
        [
          'import * as crypto from "crypto";',
          'export function authenticateUser(token: string): boolean {',
          '  return token.length > 10;',
          '}',
        ].join('\n'),
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', 'index.ts'),
        [
          'import { authenticateUser } from "./auth/jwt";',
          'export const ready = authenticateUser("valid-token-123");',
        ].join('\n'),
        'utf-8'
      );

      const engine = new OrchestratorEngine({
        workspaceRoot: tempDir,
        config: createTestConfig(),
      });

      relay = new MobileRelayServer(engine, undefined, '');
      const port = await relay.start(0);

      // 1. Search for "authenticateUser" across workspace files
      const searchRes = await httpGetJson(
        `http://127.0.0.1:${port}/api/search?q=authenticateUser`
      );
      assert.strictEqual(searchRes.statusCode, 200);
      assert.strictEqual(searchRes.body.totalMatches, 3);
      const matches = searchRes.body.matches as Array<{
        path: string;
        lineNumber: number;
        lineText: string;
      }>;
      assert.strictEqual(matches[0].path, 'src/auth/jwt.ts');
      assert.strictEqual(matches[0].lineNumber, 2);
      assert.ok(matches[0].lineText.includes('function authenticateUser'));

      // 2. Test limit query parameter
      const limitRes = await httpGetJson(
        `http://127.0.0.1:${port}/api/search?q=authenticateUser&limit=1`
      );
      assert.strictEqual(limitRes.statusCode, 200);
      assert.strictEqual(limitRes.body.totalMatches, 1);

      // 3. Missing ?q= parameter returns HTTP 400
      const badRes = await httpGetJson(`http://127.0.0.1:${port}/api/search`);
      assert.strictEqual(badRes.statusCode, 400);
    } finally {
      if (relay) {
        await relay.stop();
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

