import 'package:flutter/material.dart';
import 'models/megax_contracts.dart';
import 'services/megax_relay_service.dart';

void main() {
  runApp(const MegaXMobileApp());
}

class MegaXMobileApp extends StatelessWidget {
  const MegaXMobileApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'MeGa X Steering Wheel',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark(useMaterial3: true).copyWith(
        scaffoldBackgroundColor: const Color(0xFF0D1117),
        colorScheme: const ColorScheme.dark(
          primary: Color(0xFF58A6FF),
          secondary: Color(0xFF3FB950),
          error: Color(0xFFF85149),
          surface: Color(0xFF161B22),
        ),
      ),
      home: const SteeringWheelScreen(),
    );
  }
}

class SteeringWheelScreen extends StatefulWidget {
  const SteeringWheelScreen({super.key});

  @override
  State<SteeringWheelScreen> createState() => _SteeringWheelScreenState();
}

class _SteeringWheelScreenState extends State<SteeringWheelScreen> {
  final MegaXRelayService _relay = MegaXRelayService();
  final TextEditingController _urlController =
      TextEditingController(text: 'ws://10.0.2.2:4040/ws');
  final TextEditingController _promptController = TextEditingController();

  final List<TerminalStreamEvent> _terminalLogs = [];
  ApprovalRequestPayload? _pendingApproval;
  String _currentTaskState = 'IDLE';
  String _engineMode = 'SINGLE_AGENT';
  bool _connected = false;

  @override
  void initState() {
    super.initState();
    _relay.connectionStream.listen((connected) {
      if (mounted) setState(() => _connected = connected);
    });
    _relay.terminalStream.listen((evt) {
      if (mounted) setState(() => _terminalLogs.add(evt));
    });
    _relay.stateStream.listen((evt) {
      if (mounted) setState(() => _currentTaskState = evt.state);
    });
    _relay.approvalStream.listen((req) {
      if (mounted) setState(() => _pendingApproval = req);
    });
  }

  @override
  void dispose() {
    _relay.dispose();
    _urlController.dispose();
    _promptController.dispose();
    super.dispose();
  }

  Future<void> _toggleConnection() async {
    if (_connected) {
      await _relay.disconnect();
      return;
    }
    try {
      await _relay.connect(_urlController.text.trim());
    } catch (err) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Connection failed: $err')),
      );
    }
  }

  void _dispatchPrompt() {
    final text = _promptController.text.trim();
    if (text.isEmpty) return;

    final taskId = 'task_${DateTime.now().millisecondsSinceEpoch % 100000}';
    _relay.submitPrompt(taskId: taskId, prompt: text);
    _promptController.clear();
  }

  void _handleApproval(bool approved) {
    final req = _pendingApproval;
    if (req == null) return;

    _relay.sendApprovalDecision(
      ApprovalDecisionPayload(
        approvalId: req.approvalId,
        taskId: req.taskId,
        approved: approved,
        userNote: approved
            ? 'Approved via MeGa X Mobile Steering Wheel'
            : 'Rejected — Trigger hard Git rollback',
      ),
    );
    setState(() => _pendingApproval = null);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('MeGa X • Mobile Steering Wheel'),
        actions: [
          TextButton.icon(
            onPressed: _connected
                ? () {
                    final nextMode = _engineMode == 'SINGLE_AGENT'
                        ? 'MULTI_AGENT'
                        : 'SINGLE_AGENT';
                    setState(() => _engineMode = nextMode);
                    _relay.setEngineMode(nextMode);
                  }
                : null,
            icon: const Icon(Icons.swap_horiz, size: 18),
            label: Text(_engineMode),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Chip(
              label: Text(_currentTaskState),
              backgroundColor: const Color(0xFF21262D),
            ),
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          children: [
            // 1. Daemon Relay Connection Bar
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _urlController,
                    decoration: const InputDecoration(
                      labelText: 'Daemon Tunnel (Tailscale / Local WS)',
                      isDense: true,
                      border: OutlineInputBorder(),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton.icon(
                  onPressed: _toggleConnection,
                  icon: Icon(_connected ? Icons.link_off : Icons.link),
                  label: Text(_connected ? 'Disconnect' : 'Connect'),
                ),
              ],
            ),
            const SizedBox(height: 12),

            // 2. Interactive FCM / Security Gate Approval Card
            if (_pendingApproval != null)
              Card(
                color: const Color(0xFF3D1A1A),
                margin: const EdgeInsets.only(bottom: 12),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '⚠️ SECURITY GATE: ${_pendingApproval!.trigger}',
                        style: const TextStyle(
                          fontWeight: FontWeight.bold,
                          color: Color(0xFFFF7B72),
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(_pendingApproval!.summary),
                      const SizedBox(height: 10),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          OutlinedButton(
                            onPressed: () => _handleApproval(false),
                            child: const Text('REJECT & ROLLBACK'),
                          ),
                          const SizedBox(width: 8),
                          FilledButton(
                            onPressed: () => _handleApproval(true),
                            child: const Text('APPROVE'),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),

            // 3. Live WebSocket Terminal Output Stream
            Expanded(
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: const Color(0xFF010409),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: const Color(0xFF30363D)),
                ),
                child: _terminalLogs.isEmpty
                    ? const Center(
                        child: Text(
                          'Waiting for live Daemon terminal output...',
                          style: TextStyle(color: Colors.grey),
                        ),
                      )
                    : ListView.builder(
                        itemCount: _terminalLogs.length,
                        itemBuilder: (context, index) {
                          final item = _terminalLogs[index];
                          final color = item.stream == 'stderr'
                              ? const Color(0xFFFF7B72)
                              : item.stream == 'system'
                                  ? const Color(0xFF58A6FF)
                                  : const Color(0xFFC9D1D9);
                          return Text(
                            item.data,
                            style: TextStyle(
                              fontFamily: 'monospace',
                              fontSize: 12,
                              color: color,
                            ),
                          );
                        },
                      ),
              ),
            ),
            const SizedBox(height: 12),

            // 4. High-Level Feature Prompt Input
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _promptController,
                    decoration: const InputDecoration(
                      hintText:
                          'Enter high-level feature prompt for MeGa X...',
                      border: OutlineInputBorder(),
                    ),
                    onSubmitted: (_) => _dispatchPrompt(),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton.filled(
                  onPressed: _connected ? _dispatchPrompt : null,
                  icon: const Icon(Icons.send),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

