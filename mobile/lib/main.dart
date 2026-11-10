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
  final Set<String> _pinnedContextFiles = {};
  ApprovalRequestPayload? _pendingApproval;
  DaemonMetricsSummary? _metrics;
  GitDiffSnapshot? _diffSnapshot;
  List<String> _taskBranches = const [];
  List<QueuedTaskSummary> _queueSnapshot = const [];
  List<AuditHistoryEntry> _auditHistory = const [];
  String _currentTaskState = 'IDLE';
  String _engineMode = 'SINGLE_AGENT';
  bool _connected = false;
  bool _stderrOnlyFilter = false;

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
      await _refreshTelemetry();
    } catch (err) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Connection failed: $err')),
      );
    }
  }

  Future<void> _refreshTelemetry() async {
    if (!_connected) return;
    try {
      final status = await _relay.fetchDaemonStatus();
      final metrics = await _relay.fetchMetrics();
      final diff = await _relay.fetchDiff();
      final branches = await _relay.fetchTaskBranches();
      final queue = await _relay.fetchQueue();
      final history = await _relay.fetchAuditHistory(limit: 5);
      final approvals = await _relay.fetchPendingApprovals();
      if (!mounted) return;
      setState(() {
        _engineMode = status.engineMode;
        if (status.lastStateEvent != null) {
          _currentTaskState = status.lastStateEvent!.state;
        }
        _metrics = metrics;
        _diffSnapshot = diff;
        _taskBranches = branches;
        _queueSnapshot = queue;
        _auditHistory = history;
        if (_pendingApproval == null && approvals.isNotEmpty) {
          _pendingApproval = approvals.first;
        }
      });
    } catch (_) {
      // Ignore transient telemetry polling errors
    }
  }

  void _dispatchPrompt() {
    final text = _promptController.text.trim();
    if (text.isEmpty) return;

    final taskId = 'task_${DateTime.now().millisecondsSinceEpoch % 100000}';
    _relay.submitPrompt(
      taskId: taskId,
      prompt: text,
      contextFiles: _pinnedContextFiles.toList(),
    );
    _promptController.clear();
  }

  Future<void> _openWorkspaceFilePicker() async {
    if (!_connected) return;
    final files = await _relay.fetchWorkspaceFiles();
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setSheetState) {
            return ListView.builder(
              itemCount: files.length,
              itemBuilder: (_, idx) {
                final entry = files[idx];
                final pinned = _pinnedContextFiles.contains(entry.path);
                return CheckboxListTile(
                  value: pinned,
                  title: Text(entry.path,
                      style: const TextStyle(
                          fontFamily: 'monospace', fontSize: 13)),
                  subtitle: Text('${entry.sizeBytes} bytes'),
                  onChanged: (checked) {
                    setState(() {
                      if (checked == true) {
                        _pinnedContextFiles.add(entry.path);
                      } else {
                        _pinnedContextFiles.remove(entry.path);
                      }
                    });
                    setSheetState(() {});
                  },
                );
              },
            );
          },
        );
      },
    );
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

            // 3. Multi-Tab Console (Terminal | Git & Branches | Metrics)
            Expanded(
              child: DefaultTabController(
                length: 3,
                child: Column(
                  children: [
                    TabBar(
                      onTap: (_) => _refreshTelemetry(),
                      tabs: const [
                        Tab(text: 'Terminal'),
                        Tab(text: 'Git & Branches'),
                        Tab(text: 'Metrics'),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Expanded(
                      child: TabBarView(
                        children: [
                          // Tab 1: Live WebSocket Terminal Output Stream
                          Container(
                            width: double.infinity,
                            padding: const EdgeInsets.all(10),
                            decoration: BoxDecoration(
                              color: const Color(0xFF010409),
                              borderRadius: BorderRadius.circular(8),
                              border:
                                  Border.all(color: const Color(0xFF30363D)),
                            ),
                            child: Column(
                              children: [
                                Row(
                                  mainAxisAlignment:
                                      MainAxisAlignment.spaceBetween,
                                  children: [
                                    FilterChip(
                                      label: const Text('stderr only'),
                                      selected: _stderrOnlyFilter,
                                      onSelected: (val) => setState(
                                          () => _stderrOnlyFilter = val),
                                    ),
                                    Row(
                                      children: [
                                        TextButton.icon(
                                          onPressed: _connected
                                              ? () => _relay
                                                  .runManualVerification()
                                              : null,
                                          icon: const Icon(
                                              Icons.play_circle_outline,
                                              size: 16),
                                          label: const Text('Verify'),
                                        ),
                                        TextButton.icon(
                                          onPressed: () async {
                                            setState(
                                                () => _terminalLogs.clear());
                                            if (_connected) {
                                              await _relay.clearRemoteLogs();
                                            }
                                          },
                                          icon: const Icon(Icons.clear_all,
                                              size: 16),
                                          label: const Text('Clear'),
                                        ),
                                      ],
                                    ),
                                  ],
                                ),
                                const Divider(height: 12),
                                Expanded(
                                  child: Builder(
                                    builder: (context) {
                                      final visibleLogs = _stderrOnlyFilter
                                          ? _terminalLogs
                                              .where(
                                                  (e) => e.stream == 'stderr')
                                              .toList()
                                          : _terminalLogs;
                                      if (visibleLogs.isEmpty) {
                                        return const Center(
                                          child: Text(
                                            'Waiting for live Daemon terminal output...',
                                            style:
                                                TextStyle(color: Colors.grey),
                                          ),
                                        );
                                      }
                                      return ListView.builder(
                                        itemCount: visibleLogs.length,
                                        itemBuilder: (context, index) {
                                          final item = visibleLogs[index];
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
                                      );
                                    },
                                  ),
                                ),
                              ],
                            ),
                          ),

                          // Tab 2: Git Diff & Task Branches
                          Container(
                            width: double.infinity,
                            padding: const EdgeInsets.all(10),
                            decoration: BoxDecoration(
                              color: const Color(0xFF010409),
                              borderRadius: BorderRadius.circular(8),
                              border:
                                  Border.all(color: const Color(0xFF30363D)),
                            ),
                            child: ListView(
                              children: [
                                Text(
                                  'Active Branch: ${_diffSnapshot?.currentBranch ?? "unknown"}',
                                  style: const TextStyle(
                                      fontWeight: FontWeight.bold),
                                ),
                                const SizedBox(height: 8),
                                for (final b in _taskBranches)
                                  ListTile(
                                    dense: true,
                                    title: Text(b),
                                    trailing: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        FilledButton.tonal(
                                          onPressed: () async {
                                            await _relay.mergeTaskBranch(b);
                                            await _refreshTelemetry();
                                          },
                                          child: const Text('Merge to main'),
                                        ),
                                        const SizedBox(width: 6),
                                        IconButton(
                                          tooltip: 'Discard task branch',
                                          onPressed: () async {
                                            await _relay.deleteTaskBranch(b);
                                            await _refreshTelemetry();
                                          },
                                          icon: const Icon(
                                            Icons.delete_outline,
                                            color: Color(0xFFF85149),
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                const Divider(),
                                Text(
                                  _diffSnapshot?.unifiedDiff.isNotEmpty == true
                                      ? _diffSnapshot!.unifiedDiff
                                      : 'Working tree is clean (no uncommitted diff).',
                                  style: const TextStyle(
                                    fontFamily: 'monospace',
                                    fontSize: 12,
                                  ),
                                ),
                              ],
                            ),
                          ),

                          // Tab 3: Self-Healing Telemetry Metrics & FIFO Task Queue
                          Container(
                            width: double.infinity,
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: const Color(0xFF010409),
                              borderRadius: BorderRadius.circular(8),
                              border:
                                  Border.all(color: const Color(0xFF30363D)),
                            ),
                            child: ListView(
                              children: [
                                Text(
                                    'Total Runs: ${_metrics?.totalRuns ?? 0}'),
                                Text(
                                    'Success Rate: ${_metrics?.successRatePercent ?? 100}%'),
                                Text(
                                    'First-Attempt Passes: ${_metrics?.firstAttemptPasses ?? 0}'),
                                Text(
                                    'Self-Healed Passes: ${_metrics?.selfHealedPasses ?? 0}'),
                                Text(
                                    'Hard Rollbacks: ${_metrics?.rolledBackMicroTasks ?? 0}'),
                                const Divider(height: 20),
                                Row(
                                  mainAxisAlignment:
                                      MainAxisAlignment.spaceBetween,
                                  children: [
                                    const Text(
                                      'FIFO Task Queue',
                                      style: TextStyle(
                                          fontWeight: FontWeight.bold),
                                    ),
                                    TextButton(
                                      onPressed: _connected
                                          ? () async {
                                              await _relay.clearFinishedQueue();
                                              await _refreshTelemetry();
                                            }
                                          : null,
                                      child: const Text('Clear Finished'),
                                    ),
                                  ],
                                ),
                                for (final q in _queueSnapshot)
                                  ListTile(
                                    dense: true,
                                    title: Text('${q.taskId} • ${q.status}'),
                                    subtitle: Text(q.prompt,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis),
                                    trailing: q.status == 'QUEUED'
                                        ? OutlinedButton(
                                            onPressed: () async {
                                              await _relay
                                                  .cancelQueuedTask(q.taskId);
                                              await _refreshTelemetry();
                                            },
                                            child: const Text('Cancel'),
                                          )
                                        : null,
                                  ),
                                const Divider(height: 20),
                                Row(
                                  mainAxisAlignment:
                                      MainAxisAlignment.spaceBetween,
                                  children: [
                                    const Text(
                                      'Recent Audit History',
                                      style: TextStyle(
                                          fontWeight: FontWeight.bold),
                                    ),
                                    TextButton(
                                      onPressed: _connected
                                          ? () async {
                                              await _relay.clearAuditHistory();
                                              await _refreshTelemetry();
                                            }
                                          : null,
                                      child: const Text('Clear History'),
                                    ),
                                  ],
                                ),
                                for (final h in _auditHistory)
                                  ListTile(
                                    dense: true,
                                    leading: Icon(
                                      h.overallSuccess
                                          ? Icons.check_circle_outline
                                          : Icons.error_outline,
                                      color: h.overallSuccess
                                          ? const Color(0xFF3FB950)
                                          : const Color(0xFFF85149),
                                      size: 18,
                                    ),
                                    title: Text(
                                        '${h.masterTaskId} (${h.engineMode})'),
                                    subtitle: Text(
                                      h.prompt,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 12),

            // 4. High-Level Feature Prompt Input & Emergency Kill-Switch
            if (_pinnedContextFiles.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  children: _pinnedContextFiles
                      .map(
                        (p) => InputChip(
                          label: Text(p, style: const TextStyle(fontSize: 11)),
                          onDeleted: () =>
                              setState(() => _pinnedContextFiles.remove(p)),
                        ),
                      )
                      .toList(),
                ),
              ),
            Row(
              children: [
                IconButton.outlined(
                  onPressed: _connected ? _openWorkspaceFilePicker : null,
                  tooltip: 'Pin Workspace Context Files',
                  icon: const Icon(Icons.attach_file),
                ),
                const SizedBox(width: 6),
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
                  tooltip: 'Dispatch Prompt',
                  icon: const Icon(Icons.send),
                ),
                const SizedBox(width: 6),
                IconButton.filledTonal(
                  onPressed: _connected ? () => _relay.abortActiveTask() : null,
                  tooltip: 'Emergency Kill-Switch (Abort & Hard Rollback)',
                  icon: const Icon(Icons.stop_circle_outlined,
                      color: Color(0xFFF85149)),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

