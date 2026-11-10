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

