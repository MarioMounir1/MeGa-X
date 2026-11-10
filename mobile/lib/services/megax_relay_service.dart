import 'dart:async';
import 'dart:convert';
import 'dart:io';
import '../models/megax_contracts.dart';

/// Bi-directional WebSocket & FCM Interactive Action client connecting
/// the Flutter Mobile Controller to the Local PC Daemon (`ws://<host>:<port>/ws`).
class MegaXRelayService {
  WebSocket? _socket;
  String _httpBaseUrl = 'http://10.0.2.2:4040';

  final _terminalController = StreamController<TerminalStreamEvent>.broadcast();
  final _stateController = StreamController<TaskStateChangeEvent>.broadcast();
  final _approvalController =
      StreamController<ApprovalRequestPayload>.broadcast();
  final _connectionController = StreamController<bool>.broadcast();

  Stream<TerminalStreamEvent> get terminalStream => _terminalController.stream;
  Stream<TaskStateChangeEvent> get stateStream => _stateController.stream;
  Stream<ApprovalRequestPayload> get approvalStream =>
      _approvalController.stream;
  Stream<bool> get connectionStream => _connectionController.stream;

  bool get isConnected => _socket != null;

  Future<void> connect(String wsUrl) async {
    await disconnect();
    _httpBaseUrl = wsUrl
        .replaceFirst(RegExp(r'^wss://'), 'https://')
        .replaceFirst(RegExp(r'^ws://'), 'http://')
        .replaceFirst(RegExp(r'/ws$'), '');
    final socket = await WebSocket.connect(wsUrl);
    _socket = socket;
    _connectionController.add(true);

    socket.listen(
      (dynamic raw) {
        if (raw is! String) return;
        final decoded = jsonDecode(raw) as Map<String, dynamic>;
        final type = decoded['type'] as String?;
        final payload = decoded['payload'] as Map<String, dynamic>? ?? {};

        switch (type) {
          case 'TERMINAL_STREAM':
            _terminalController.add(TerminalStreamEvent.fromJson(payload));
            break;
          case 'STATE_CHANGE':
            _stateController.add(TaskStateChangeEvent.fromJson(payload));
            break;
          case 'APPROVAL_REQUIRED':
            _approvalController.add(ApprovalRequestPayload.fromJson(payload));
            break;
        }
      },
      onDone: () {
        _socket = null;
        _connectionController.add(false);
      },
      onError: (_) {
        _socket = null;
        _connectionController.add(false);
      },
    );
  }

  void submitPrompt({
    required String taskId,
    required String prompt,
    List<String> contextFiles = const [],
  }) {
    final socket = _socket;
    if (socket == null) return;

    socket.add(
      jsonEncode({
        'type': 'PROMPT_SUBMIT',
        'taskId': taskId,
        'prompt': prompt,
        'contextFiles': contextFiles,
      }),
    );
  }

  void sendApprovalDecision(ApprovalDecisionPayload decision) {
    final socket = _socket;
    if (socket == null) return;

    socket.add(
      jsonEncode({
        'type': 'APPROVAL_DECISION',
        'payload': decision.toJson(),
      }),
    );
  }

  void setEngineMode(String engineMode) {
    final socket = _socket;
    if (socket == null) return;

    socket.add(
      jsonEncode({
        'type': 'SET_ENGINE_MODE',
        'engineMode': engineMode,
      }),
    );
  }

  void abortActiveTask() {
    final socket = _socket;
    if (socket == null) return;

    socket.add(jsonEncode({'type': 'ABORT_TASK'}));
  }

  Future<DaemonStatusSnapshot> fetchDaemonStatus() async {
    final client = HttpClient();
    try {
      final req = await client.getUrl(Uri.parse('$_httpBaseUrl/api/status'));
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();
      return DaemonStatusSnapshot.fromJson(
          jsonDecode(body) as Map<String, dynamic>);
    } finally {
      client.close();
    }
  }

  Future<DaemonMetricsSummary> fetchMetrics() async {
    final client = HttpClient();
    try {
      final req = await client.getUrl(Uri.parse('$_httpBaseUrl/api/metrics'));
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();
      return DaemonMetricsSummary.fromJson(
          jsonDecode(body) as Map<String, dynamic>);
    } finally {
      client.close();
    }
  }

  Future<GitDiffSnapshot> fetchDiff() async {
    final client = HttpClient();
    try {
      final req = await client.getUrl(Uri.parse('$_httpBaseUrl/api/diff'));
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();
      return GitDiffSnapshot.fromJson(
          jsonDecode(body) as Map<String, dynamic>);
    } finally {
      client.close();
    }
  }

  Future<List<String>> fetchTaskBranches() async {
    final client = HttpClient();
    try {
      final req = await client.getUrl(Uri.parse('$_httpBaseUrl/api/branches'));
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();
      final decoded = jsonDecode(body) as Map<String, dynamic>;
      return (decoded['taskBranches'] as List<dynamic>?)
              ?.map((e) => e.toString())
              .toList() ??
          const [];
    } finally {
      client.close();
    }
  }

  Future<void> mergeTaskBranch(String taskBranch) async {
    final client = HttpClient();
    try {
      final req = await client.postUrl(Uri.parse('$_httpBaseUrl/api/merge'));
      req.headers.contentType = ContentType.json;
      req.write(jsonEncode({'taskBranch': taskBranch, 'targetBranch': 'main'}));
      await req.close();
    } finally {
      client.close();
    }
  }

  Future<void> deleteTaskBranch(String taskBranch) async {
    final client = HttpClient();
    try {
      final req =
          await client.postUrl(Uri.parse('$_httpBaseUrl/api/branches/delete'));
      req.headers.contentType = ContentType.json;
      req.write(
          jsonEncode({'taskBranch': taskBranch, 'fallbackBranch': 'main'}));
      await req.close();
    } finally {
      client.close();
    }
  }

  Future<String> fetchBranchDiff(String taskBranch,
      {String baseBranch = 'main'}) async {
    final client = HttpClient();
    try {
      final uri = Uri.parse('$_httpBaseUrl/api/branches/diff').replace(
        queryParameters: {'branch': taskBranch, 'base': baseBranch},
      );
      final req = await client.getUrl(uri);
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();
      final decoded = jsonDecode(body) as Map<String, dynamic>;
      return decoded['unifiedDiff'] as String? ?? '';
    } finally {
      client.close();
    }
  }

  Future<List<GitCommitEntry>> fetchRecentCommits() async {
    final client = HttpClient();
    try {
      final req = await client.getUrl(Uri.parse('$_httpBaseUrl/api/commits'));
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();
      final decoded = jsonDecode(body) as Map<String, dynamic>;
      return (decoded['commits'] as List<dynamic>?)
              ?.map((e) => GitCommitEntry.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [];
    } finally {
      client.close();
    }
  }

  Future<bool> runManualVerification() async {
    final client = HttpClient();
    try {
      final req = await client.postUrl(Uri.parse('$_httpBaseUrl/api/verify'));
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();
      final decoded = jsonDecode(body) as Map<String, dynamic>;
      return decoded['passed'] as bool? ?? false;
    } finally {
      client.close();
    }
  }

  Future<List<WorkspaceFileEntry>> fetchWorkspaceFiles({String? query}) async {
    final client = HttpClient();
    try {
      final uri = Uri.parse('$_httpBaseUrl/api/files').replace(
        queryParameters:
            (query != null && query.trim().isNotEmpty) ? {'query': query} : null,
      );
      final req = await client.getUrl(uri);
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();
      final decoded = jsonDecode(body) as Map<String, dynamic>;
      return (decoded['files'] as List<dynamic>?)
              ?.map((e) =>
                  WorkspaceFileEntry.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [];
    } finally {
      client.close();
    }
  }

  Future<WorkspaceFileContent> fetchFileContent(String relativePath) async {
    final client = HttpClient();
    try {
      final uri = Uri.parse('$_httpBaseUrl/api/file')
          .replace(queryParameters: {'path': relativePath});
      final req = await client.getUrl(uri);
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();
      return WorkspaceFileContent.fromJson(
          jsonDecode(body) as Map<String, dynamic>);
    } finally {
      client.close();
    }
  }

  Future<List<QueuedTaskSummary>> fetchQueue() async {
    final client = HttpClient();
    try {
      final req = await client.getUrl(Uri.parse('$_httpBaseUrl/api/queue'));
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();
      final decoded = jsonDecode(body) as Map<String, dynamic>;
      return (decoded['queue'] as List<dynamic>?)
              ?.map(
                  (e) => QueuedTaskSummary.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [];
    } finally {
      client.close();
    }
  }

  Future<bool> cancelQueuedTask(String taskId) async {
    final client = HttpClient();
    try {
      final req =
          await client.postUrl(Uri.parse('$_httpBaseUrl/api/queue/cancel'));
      req.headers.contentType = ContentType.json;
      req.write(jsonEncode({'taskId': taskId}));
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();
      final decoded = jsonDecode(body) as Map<String, dynamic>;
      return decoded['cancelled'] as bool? ?? false;
    } finally {
      client.close();
    }
  }

  Future<int> clearFinishedQueue() async {
    final client = HttpClient();
    try {
      final req =
          await client.postUrl(Uri.parse('$_httpBaseUrl/api/queue/clear'));
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();
      final decoded = jsonDecode(body) as Map<String, dynamic>;
      return (decoded['clearedCount'] as num?)?.toInt() ?? 0;
    } finally {
      client.close();
    }
  }

  Future<List<AuditHistoryEntry>> fetchAuditHistory({
    String? status,
    int? limit,
  }) async {
    final client = HttpClient();
    try {
      final queryParams = <String, String>{};
      if (status != null && status.isNotEmpty) {
        queryParams['status'] = status;
      }
      if (limit != null && limit > 0) {
        queryParams['limit'] = limit.toString();
      }
      final uri = Uri.parse('$_httpBaseUrl/api/history').replace(
        queryParameters: queryParams.isNotEmpty ? queryParams : null,
      );
      final req = await client.getUrl(uri);
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();
      final decoded = jsonDecode(body) as Map<String, dynamic>;
      return (decoded['history'] as List<dynamic>?)
              ?.map(
                  (e) => AuditHistoryEntry.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [];
    } finally {
      client.close();
    }
  }

  Future<int> clearAuditHistory() async {
    final client = HttpClient();
    try {
      final req =
          await client.postUrl(Uri.parse('$_httpBaseUrl/api/history/clear'));
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();
      final decoded = jsonDecode(body) as Map<String, dynamic>;
      return (decoded['clearedCount'] as num?)?.toInt() ?? 0;
    } finally {
      client.close();
    }
  }

  Future<List<TerminalStreamEvent>> fetchLogs({
    String? stream,
    String? taskId,
    int? limit,
  }) async {
    final client = HttpClient();
    try {
      final queryParams = <String, String>{};
      if (stream != null && stream.isNotEmpty) {
        queryParams['stream'] = stream;
      }
      if (taskId != null && taskId.isNotEmpty) {
        queryParams['taskId'] = taskId;
      }
      if (limit != null && limit > 0) {
        queryParams['limit'] = limit.toString();
      }
      final uri = Uri.parse('$_httpBaseUrl/api/logs').replace(
        queryParameters: queryParams.isNotEmpty ? queryParams : null,
      );
      final req = await client.getUrl(uri);
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();
      final decoded = jsonDecode(body) as Map<String, dynamic>;
      return (decoded['logs'] as List<dynamic>?)
              ?.map((e) =>
                  TerminalStreamEvent.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [];
    } finally {
      client.close();
    }
  }

  Future<int> clearRemoteLogs() async {
    final client = HttpClient();
    try {
      final req =
          await client.postUrl(Uri.parse('$_httpBaseUrl/api/logs/clear'));
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();
      final decoded = jsonDecode(body) as Map<String, dynamic>;
      return (decoded['clearedCount'] as num?)?.toInt() ?? 0;
    } finally {
      client.close();
    }
  }

  Future<List<ApprovalRequestPayload>> fetchPendingApprovals() async {
    final client = HttpClient();
    try {
      final req =
          await client.getUrl(Uri.parse('$_httpBaseUrl/api/approvals'));
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();
      final decoded = jsonDecode(body) as Map<String, dynamic>;
      return (decoded['pendingApprovals'] as List<dynamic>?)
              ?.map((e) =>
                  ApprovalRequestPayload.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [];
    } finally {
      client.close();
    }
  }

  Future<AgentRosterSnapshot> fetchAgentRoster() async {
    final client = HttpClient();
    try {
      final req = await client.getUrl(Uri.parse('$_httpBaseUrl/api/agents'));
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();
      return AgentRosterSnapshot.fromJson(
          jsonDecode(body) as Map<String, dynamic>);
    } finally {
      client.close();
    }
  }

  Future<void> updateAgentAssignments({
    String? primaryAgent,
    String? planner,
    String? executor,
    String? reviewer,
  }) async {
    final client = HttpClient();
    try {
      final req = await client.postUrl(Uri.parse('$_httpBaseUrl/api/config'));
      req.headers.contentType = ContentType.json;
      final multiAgentPatch = <String, String>{};
      if (planner != null) multiAgentPatch['planner'] = planner;
      if (executor != null) multiAgentPatch['executor'] = executor;
      if (reviewer != null) multiAgentPatch['reviewer'] = reviewer;
      req.write(
        jsonEncode({
          if (primaryAgent != null) 'primaryAgent': primaryAgent,
          if (multiAgentPatch.isNotEmpty) 'multiAgentConfig': multiAgentPatch,
        }),
      );
      await req.close();
    } finally {
      client.close();
    }
  }

  Future<bool> sendTestFcmPush({String? title, String? body}) async {
    final client = HttpClient();
    try {
      final req = await client.postUrl(Uri.parse('$_httpBaseUrl/api/fcm/test'));
      req.headers.contentType = ContentType.json;
      req.write(
        jsonEncode({
          if (title != null) 'title': title,
          if (body != null) 'body': body,
        }),
      );
      final res = await req.close();
      final raw = await res.transform(utf8.decoder).join();
      final decoded = jsonDecode(raw) as Map<String, dynamic>;
      return decoded['dispatched'] as bool? ?? false;
    } finally {
      client.close();
    }
  }

  Future<int> fetchFcmHistoryCount() async {
    final client = HttpClient();
    try {
      final req =
          await client.getUrl(Uri.parse('$_httpBaseUrl/api/fcm/history'));
      final res = await req.close();
      final raw = await res.transform(utf8.decoder).join();
      final decoded = jsonDecode(raw) as Map<String, dynamic>;
      return (decoded['totalCount'] as num?)?.toInt() ?? 0;
    } finally {
      client.close();
    }
  }

  Future<void> disconnect() async {
    await _socket?.close();
    _socket = null;
    _connectionController.add(false);
  }

  void dispose() {
    disconnect();
    _terminalController.close();
    _stateController.close();
    _approvalController.close();
    _connectionController.close();
  }
}

