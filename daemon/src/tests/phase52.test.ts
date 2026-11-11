import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { TunnelInspector } from '../relay/tunnelInspector';

describe('Phase 52: Mobile Client Flutter Contract Parity & Deep-Link Protocol Verification', () => {
  const rootDir = path.resolve(__dirname, '..', '..', '..');
  const mobileDir = path.join(rootDir, 'mobile');

  it('verifies mobile Flutter project structure and essential source files exist', () => {
    assert.strictEqual(fs.existsSync(path.join(mobileDir, 'pubspec.yaml')), true);
    assert.strictEqual(fs.existsSync(path.join(mobileDir, 'lib', 'main.dart')), true);
    assert.strictEqual(
      fs.existsSync(path.join(mobileDir, 'lib', 'models', 'megax_contracts.dart')),
      true
    );
    assert.strictEqual(
      fs.existsSync(path.join(mobileDir, 'lib', 'services', 'megax_relay_service.dart')),
      true
    );
  });

  it('verifies Dart contracts mirror core TypeScript daemon schemas', () => {
    const dartContracts = fs.readFileSync(
      path.join(mobileDir, 'lib', 'models', 'megax_contracts.dart'),
      'utf-8'
    );

    // Verify presence of all key classes in Dart
    const expectedClasses = [
      'TerminalStreamEvent',
      'TaskStateChangeEvent',
      'ApprovalRequestPayload',
      'ApprovalDecisionPayload',
      'DaemonMetricsSummary',
      'GitDiffSnapshot',
      'WorkspaceFileEntry',
      'WorkspaceFileContent',
      'QueuedTaskSummary',
      'AuditHistoryEntry',
      'DaemonStatusSnapshot',
      'AgentRosterSnapshot',
      'GitStashEntry',
      'WorkspaceSearchMatch',
      'SecurityGateSummary',
      'PatchDryRunResult',
      'MobilePairingManifest',
      'DaemonInstanceSummary',
    ];

    for (const cls of expectedClasses) {
      assert.ok(
        dartContracts.includes(`class ${cls}`),
        `Expected Dart contract to define class ${cls}`
      );
    }
  });

  it('ensures deep-link QR pairing format emitted by daemon is compatible with mobile parser', () => {
    const pairingInfo = TunnelInspector.getPairingInfo(4040, true);
    const payload = TunnelInspector.generatePairingQrPayload(pairingInfo, 'sec_abc');

    assert.ok(payload.qrUri.startsWith('megax://connect'));
    const parsedUrl = new URL(payload.qrUri);
    assert.strictEqual(parsedUrl.protocol, 'megax:');
    assert.strictEqual(parsedUrl.hostname, 'connect');
    assert.strictEqual(parsedUrl.searchParams.get('token'), 'sec_abc');
    assert.strictEqual(
      parsedUrl.searchParams.get('url'),
      pairingInfo.recommendedWsUrl
    );
  });
});
