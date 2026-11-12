import 'package:flutter_test/flutter_test.dart';
import 'package:megax_mobile_controller/models/megax_contracts.dart';

void main() {
  group('MeGa X Mobile Contract Tests (Phase 52)', () {
    test('Serializes & deserializes DaemonMetricsSummary & TaskStateChangeEvent', () {
      final stateEvt = TaskStateChangeEvent.fromJson({
        'taskId': 'task_52',
        'state': 'VERIFYING',
        'attempt': 1,
        'message': 'Running npm test',
        'timestamp': '2026-11-11T18:00:00Z',
      });
      expect(stateEvt.taskId, 'task_52');
      expect(stateEvt.state, 'VERIFYING');

      final metrics = DaemonMetricsSummary.fromJson({
        'totalRuns': 10,
        'successfulRuns': 9,
        'successRatePercent': 90,
        'firstAttemptPasses': 7,
        'selfHealedPasses': 2,
        'rolledBackMicroTasks': 1,
        'averageAttemptsPerTask': 1.3,
        'modeBreakdown': {
          'singleAgentRuns': 6,
          'multiAgentRuns': 4,
        },
      });
      expect(metrics.totalRuns, 10);
      expect(metrics.successRatePercent, 90);
      expect(metrics.singleAgentRuns, 6);
      expect(metrics.multiAgentRuns, 4);
    });

    test('Parses GitDiffSnapshot, GitCommitEntry, and GitStashEntry', () {
      final diff = GitDiffSnapshot.fromJson({
        'currentBranch': 'megax/task-52',
        'statusLines': [' M lib/main.dart'],
        'unifiedDiff': '+ // New Phase 52 mobile code',
      });
      expect(diff.currentBranch, 'megax/task-52');
      expect(diff.statusLines.length, 1);

      final commit = GitCommitEntry.fromJson({
        'hash': 'abc1234',
        'subject': 'feat: phase 52',
        'author': 'Developer',
        'date': '2026-11-11',
      });
      expect(commit.hash, 'abc1234');

      final stash = GitStashEntry.fromJson({
        'ref': 'stash@{0}',
        'message': 'WIP on main',
        'date': '2026-11-11',
      });
      expect(stash.ref, 'stash@{0}');
    });

    test('Parses WorkspaceFileEntry, WorkspaceSearchMatch, and SecurityGateSummary', () {
      final fileEntry = WorkspaceFileEntry.fromJson({
        'path': 'lib/main.dart',
        'sizeBytes': 2048,
        'extension': '.dart',
        'modifiedAt': '2026-11-11T18:00:00Z',
      });
      expect(fileEntry.path, 'lib/main.dart');
      expect(fileEntry.extension, '.dart');

      final match = WorkspaceSearchMatch.fromJson({
        'path': 'lib/main.dart',
        'lineNumber': 42,
        'lineText': 'const MegaXMobileApp()',
      });
      expect(match.lineNumber, 42);

      final sec = SecurityGateSummary.fromJson({
        'requireApprovalOn': ['DB_MIGRATION', 'FILE_DELETE'],
        'approvalTimeoutMs': 30000,
        'hasApprovalHandler': true,
        'protectedFileRuleCount': 4,
      });
      expect(sec.requireApprovalOn.contains('DB_MIGRATION'), true);
      expect(sec.approvalTimeoutMs, 30000);
    });

    test('Parses PatchDryRunResult and MobilePairingManifest with QR URI', () {
      final dryRun = PatchDryRunResult.fromJson({
        'valid': true,
        'modifiedCount': 2,
        'createdCount': 1,
        'deletedCount': 0,
        'error': null,
      });
      expect(dryRun.valid, true);
      expect(dryRun.createdCount, 1);

      final pairing = MobilePairingManifest.fromJson({
        'hostname': '100.64.0.10',
        'port': 4040,
        'requiresToken': true,
        'recommendedWsUrl': 'ws://100.64.0.10:4040/ws?token=sec_token',
        'androidEmulatorWsUrl': 'ws://10.0.2.2:4040/ws?token=sec_token',
        'qrPayload': {
          'qrUri': 'megax://connect?ws=ws%3A%2F%2F100.64.0.10%3A4040%2Fws&token=sec_token',
        },
      });
      expect(pairing.requiresToken, true);
      expect(pairing.qrUri, contains('megax://connect'));

      final uri = Uri.parse(pairing.qrUri!);
      expect(uri.scheme, 'megax');
      expect(uri.host, 'connect');
      expect(uri.queryParameters['token'], 'sec_token');
    });

    test('Parses DaemonInstanceSummary', () {
      final summary = DaemonInstanceSummary.fromJson({
        'version': '1.0.0',
        'projectName': 'MeGa-X',
        'engineMode': 'MULTI_AGENT',
        'workspaceRoot': '/workspace',
        'endpoints': {
          'dashboardUrl': 'http://localhost:4040/',
          'wsUrl': 'ws://localhost:4040/ws',
          'pairingUrl': 'http://localhost:4040/api/pairing',
        },
      });
      expect(summary.version, '1.0.0');
      expect(summary.engineMode, 'MULTI_AGENT');
      expect(summary.dashboardUrl, 'http://localhost:4040/');
    });

    test('Parses ConsensusEvaluationModel & AgentVoteModel', () {
      final consensus = ConsensusEvaluationModel.fromJson({
        'taskId': 'task_eval_1',
        'status': 'MAJORITY_APPROVAL',
        'approvalRatio': 0.67,
        'votes': [
          {'agentId': 'claude', 'role': 'PLANNER', 'approved': true},
          {'agentId': 'antigravity', 'role': 'EXECUTOR', 'approved': true},
          {'agentId': 'codex', 'role': 'REVIEWER', 'approved': false, 'feedback': 'Refactor requested'},
        ],
        'conflictingFiles': ['src/app.ts'],
        'requiresMobileEscalation': false,
        'resolutionStrategyApplied': 'SYNTHESIS',
        'evaluatedAt': '2026-11-12T22:00:00Z',
      });

      expect(consensus.taskId, 'task_eval_1');
      expect(consensus.status, 'MAJORITY_APPROVAL');
      expect(consensus.approvalRatio, 0.67);
      expect(consensus.votes.length, 3);
      expect(consensus.votes[2].feedback, 'Refactor requested');
      expect(consensus.conflictingFiles, ['src/app.ts']);
      expect(consensus.resolutionStrategyApplied, 'SYNTHESIS');
    });
  });
}

