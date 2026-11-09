import 'dart:async';
import 'dart:convert';
import 'dart:io';
import '../models/megax_contracts.dart';

/// Bi-directional WebSocket & FCM Interactive Action client connecting
/// the Flutter Mobile Controller to the Local PC Daemon (`ws://<host>:<port>/ws`).
class MegaXRelayService {
  WebSocket? _socket;

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

