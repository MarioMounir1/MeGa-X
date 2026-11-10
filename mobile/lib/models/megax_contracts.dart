/// PROJECT MeGa X - DART DATA CONTRACTS (MIRRORING TYPESCRIPT DAEMON SCHEMAS)

class TerminalStreamEvent {
  final String taskId;
  final String stream; // 'stdout' | 'stderr' | 'system'
  final String data;
  final int attempt;
  final String timestamp;

  const TerminalStreamEvent({
    required this.taskId,
    required this.stream,
    required this.data,
    required this.attempt,
    required this.timestamp,
  });

  factory TerminalStreamEvent.fromJson(Map<String, dynamic> json) {
    return TerminalStreamEvent(
      taskId: json['taskId'] as String? ?? '',
      stream: json['stream'] as String? ?? 'system',
      data: json['data'] as String? ?? '',
      attempt: (json['attempt'] as num?)?.toInt() ?? 1,
      timestamp: json['timestamp'] as String? ?? '',
    );
  }
}

class TaskStateChangeEvent {
  final String taskId;
  final String state;
  final int attempt;
  final String message;
  final String timestamp;

  const TaskStateChangeEvent({
    required this.taskId,
    required this.state,
    required this.attempt,
    required this.message,
    required this.timestamp,
  });

  factory TaskStateChangeEvent.fromJson(Map<String, dynamic> json) {
    return TaskStateChangeEvent(
      taskId: json['taskId'] as String? ?? '',
      state: json['state'] as String? ?? 'IDLE',
      attempt: (json['attempt'] as num?)?.toInt() ?? 0,
      message: json['message'] as String? ?? '',
      timestamp: json['timestamp'] as String? ?? '',
    );
  }
}

class ApprovalRequestPayload {
  final String approvalId;
  final String taskId;
  final String trigger; // 'DB_MIGRATION' | 'FILE_DELETE' | 'MAX_RETRY_EXCEEDED'
  final String summary;
  final List<String> affectedFiles;
  final String timestamp;

  const ApprovalRequestPayload({
    required this.approvalId,
    required this.taskId,
    required this.trigger,
    required this.summary,
    required this.affectedFiles,
    required this.timestamp,
  });

  factory ApprovalRequestPayload.fromJson(Map<String, dynamic> json) {
    final files = (json['affectedFiles'] as List<dynamic>?)
            ?.map((e) => e.toString())
            .toList() ??
        const [];
    return ApprovalRequestPayload(
      approvalId: json['approvalId'] as String? ?? '',
      taskId: json['taskId'] as String? ?? '',
      trigger: json['trigger'] as String? ?? 'FILE_DELETE',
      summary: json['summary'] as String? ?? '',
      affectedFiles: files,
      timestamp: json['timestamp'] as String? ?? '',
    );
  }
}

class ApprovalDecisionPayload {
  final String approvalId;
  final String taskId;
  final bool approved;
  final String? userNote;

  const ApprovalDecisionPayload({
    required this.approvalId,
    required this.taskId,
    required this.approved,
    this.userNote,
  });

  Map<String, dynamic> toJson() => {
        'approvalId': approvalId,
        'taskId': taskId,
        'approved': approved,
        if (userNote != null) 'userNote': userNote,
      };
}

class DaemonMetricsSummary {
  final int totalRuns;
  final int successfulRuns;
  final int successRatePercent;
  final int firstAttemptPasses;
  final int selfHealedPasses;
  final int rolledBackMicroTasks;

  const DaemonMetricsSummary({
    required this.totalRuns,
    required this.successfulRuns,
    required this.successRatePercent,
    required this.firstAttemptPasses,
    required this.selfHealedPasses,
    required this.rolledBackMicroTasks,
  });

  factory DaemonMetricsSummary.fromJson(Map<String, dynamic> json) {
    return DaemonMetricsSummary(
      totalRuns: (json['totalRuns'] as num?)?.toInt() ?? 0,
      successfulRuns: (json['successfulRuns'] as num?)?.toInt() ?? 0,
      successRatePercent: (json['successRatePercent'] as num?)?.toInt() ?? 100,
      firstAttemptPasses: (json['firstAttemptPasses'] as num?)?.toInt() ?? 0,
      selfHealedPasses: (json['selfHealedPasses'] as num?)?.toInt() ?? 0,
      rolledBackMicroTasks:
          (json['rolledBackMicroTasks'] as num?)?.toInt() ?? 0,
    );
  }
}

class GitDiffSnapshot {
  final String currentBranch;
  final List<String> statusLines;
  final String unifiedDiff;

  const GitDiffSnapshot({
    required this.currentBranch,
    required this.statusLines,
    required this.unifiedDiff,
  });

  factory GitDiffSnapshot.fromJson(Map<String, dynamic> json) {
    final lines = (json['statusLines'] as List<dynamic>?)
            ?.map((e) => e.toString())
            .toList() ??
        const [];
    return GitDiffSnapshot(
      currentBranch: json['currentBranch'] as String? ?? 'main',
      statusLines: lines,
      unifiedDiff: json['unifiedDiff'] as String? ?? '',
    );
  }
}

