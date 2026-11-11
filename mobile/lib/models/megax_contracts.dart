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
  final double averageAttemptsPerTask;
  final int singleAgentRuns;
  final int multiAgentRuns;

  const DaemonMetricsSummary({
    required this.totalRuns,
    required this.successfulRuns,
    required this.successRatePercent,
    required this.firstAttemptPasses,
    required this.selfHealedPasses,
    required this.rolledBackMicroTasks,
    this.averageAttemptsPerTask = 0.0,
    this.singleAgentRuns = 0,
    this.multiAgentRuns = 0,
  });

  factory DaemonMetricsSummary.fromJson(Map<String, dynamic> json) {
    final mode = json['modeBreakdown'] as Map<String, dynamic>? ?? const {};
    return DaemonMetricsSummary(
      totalRuns: (json['totalRuns'] as num?)?.toInt() ?? 0,
      successfulRuns: (json['successfulRuns'] as num?)?.toInt() ?? 0,
      successRatePercent: (json['successRatePercent'] as num?)?.toInt() ?? 100,
      firstAttemptPasses: (json['firstAttemptPasses'] as num?)?.toInt() ?? 0,
      selfHealedPasses: (json['selfHealedPasses'] as num?)?.toInt() ?? 0,
      rolledBackMicroTasks:
          (json['rolledBackMicroTasks'] as num?)?.toInt() ?? 0,
      averageAttemptsPerTask:
          (json['averageAttemptsPerTask'] as num?)?.toDouble() ?? 0.0,
      singleAgentRuns: (mode['singleAgentRuns'] as num?)?.toInt() ?? 0,
      multiAgentRuns: (mode['multiAgentRuns'] as num?)?.toInt() ?? 0,
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

class GitCommitEntry {
  final String hash;
  final String subject;
  final String author;
  final String date;

  const GitCommitEntry({
    required this.hash,
    required this.subject,
    required this.author,
    required this.date,
  });

  factory GitCommitEntry.fromJson(Map<String, dynamic> json) {
    return GitCommitEntry(
      hash: json['hash'] as String? ?? '',
      subject: json['subject'] as String? ?? '',
      author: json['author'] as String? ?? '',
      date: json['date'] as String? ?? '',
    );
  }
}

class WorkspaceFileEntry {
  final String path;
  final int sizeBytes;
  final String extension;
  final String modifiedAt;

  const WorkspaceFileEntry({
    required this.path,
    required this.sizeBytes,
    required this.extension,
    required this.modifiedAt,
  });

  factory WorkspaceFileEntry.fromJson(Map<String, dynamic> json) {
    return WorkspaceFileEntry(
      path: json['path'] as String? ?? '',
      sizeBytes: (json['sizeBytes'] as num?)?.toInt() ?? 0,
      extension: json['extension'] as String? ?? '',
      modifiedAt: json['modifiedAt'] as String? ?? '',
    );
  }
}

class WorkspaceFileContent {
  final String path;
  final String content;
  final int sizeBytes;
  final int lineCount;

  const WorkspaceFileContent({
    required this.path,
    required this.content,
    required this.sizeBytes,
    required this.lineCount,
  });

  factory WorkspaceFileContent.fromJson(Map<String, dynamic> json) {
    return WorkspaceFileContent(
      path: json['path'] as String? ?? '',
      content: json['content'] as String? ?? '',
      sizeBytes: (json['sizeBytes'] as num?)?.toInt() ?? 0,
      lineCount: (json['lineCount'] as num?)?.toInt() ?? 0,
    );
  }
}

class QueuedTaskSummary {
  final String taskId;
  final String prompt;
  final String status; // 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  final String enqueuedAt;

  const QueuedTaskSummary({
    required this.taskId,
    required this.prompt,
    required this.status,
    required this.enqueuedAt,
  });

  factory QueuedTaskSummary.fromJson(Map<String, dynamic> json) {
    return QueuedTaskSummary(
      taskId: json['taskId'] as String? ?? '',
      prompt: json['prompt'] as String? ?? '',
      status: json['status'] as String? ?? 'QUEUED',
      enqueuedAt: json['enqueuedAt'] as String? ?? '',
    );
  }
}

class AuditHistoryEntry {
  final String masterTaskId;
  final String prompt;
  final String engineMode;
  final bool overallSuccess;
  final String recordedAt;

  const AuditHistoryEntry({
    required this.masterTaskId,
    required this.prompt,
    required this.engineMode,
    required this.overallSuccess,
    required this.recordedAt,
  });

  factory AuditHistoryEntry.fromJson(Map<String, dynamic> json) {
    return AuditHistoryEntry(
      masterTaskId: json['masterTaskId'] as String? ?? '',
      prompt: json['prompt'] as String? ?? '',
      engineMode: json['engineMode'] as String? ?? 'SINGLE_AGENT',
      overallSuccess: json['overallSuccess'] as bool? ?? false,
      recordedAt: json['recordedAt'] as String? ?? '',
    );
  }
}

class DaemonStatusSnapshot {
  final String status;
  final String projectName;
  final String engineMode;
  final int connectedClients;
  final int uptimeSeconds;
  final TaskStateChangeEvent? lastStateEvent;

  const DaemonStatusSnapshot({
    required this.status,
    required this.projectName,
    required this.engineMode,
    required this.connectedClients,
    required this.uptimeSeconds,
    this.lastStateEvent,
  });

  factory DaemonStatusSnapshot.fromJson(Map<String, dynamic> json) {
    final rawLast = json['lastStateEvent'];
    return DaemonStatusSnapshot(
      status: json['status'] as String? ?? 'ONLINE',
      projectName: json['projectName'] as String? ?? '',
      engineMode: json['engineMode'] as String? ?? 'SINGLE_AGENT',
      connectedClients: (json['connectedClients'] as num?)?.toInt() ?? 0,
      uptimeSeconds: (json['uptimeSeconds'] as num?)?.toInt() ?? 0,
      lastStateEvent: rawLast is Map<String, dynamic>
          ? TaskStateChangeEvent.fromJson(rawLast)
          : null,
    );
  }
}

class AgentRosterSnapshot {
  final String engineMode;
  final List<String> registeredAgents;
  final String primaryAgent;
  final String planner;
  final String executor;
  final String? reviewer;

  const AgentRosterSnapshot({
    required this.engineMode,
    required this.registeredAgents,
    required this.primaryAgent,
    required this.planner,
    required this.executor,
    this.reviewer,
  });

  factory AgentRosterSnapshot.fromJson(Map<String, dynamic> json) {
    final agents = (json['registeredAgents'] as List<dynamic>?)
            ?.map((e) => e.toString())
            .toList() ??
        const [];
    final roles = json['activeRoles'] as Map<String, dynamic>? ?? const {};
    return AgentRosterSnapshot(
      engineMode: json['engineMode'] as String? ?? 'SINGLE_AGENT',
      registeredAgents: agents,
      primaryAgent: roles['primaryAgent'] as String? ?? 'claude-3-7-sonnet',
      planner: roles['planner'] as String? ?? 'claude-3-7-sonnet',
      executor: roles['executor'] as String? ?? 'antigravity',
      reviewer: roles['reviewer'] as String?,
    );
  }
}

class GitStashEntry {
  final String ref;
  final String message;
  final String date;

  const GitStashEntry({
    required this.ref,
    required this.message,
    required this.date,
  });

  factory GitStashEntry.fromJson(Map<String, dynamic> json) {
    return GitStashEntry(
      ref: json['ref'] as String? ?? '',
      message: json['message'] as String? ?? '',
      date: json['date'] as String? ?? '',
    );
  }
}

class WorkspaceSearchMatch {
  final String path;
  final int lineNumber;
  final String lineText;

  const WorkspaceSearchMatch({
    required this.path,
    required this.lineNumber,
    required this.lineText,
  });

  factory WorkspaceSearchMatch.fromJson(Map<String, dynamic> json) {
    return WorkspaceSearchMatch(
      path: json['path'] as String? ?? '',
      lineNumber: (json['lineNumber'] as num?)?.toInt() ?? 1,
      lineText: json['lineText'] as String? ?? '',
    );
  }
}

class SecurityGateSummary {
  final List<String> requireApprovalOn;
  final int? approvalTimeoutMs;
  final bool hasApprovalHandler;
  final int protectedFileRuleCount;

  const SecurityGateSummary({
    required this.requireApprovalOn,
    this.approvalTimeoutMs,
    required this.hasApprovalHandler,
    required this.protectedFileRuleCount,
  });

  factory SecurityGateSummary.fromJson(Map<String, dynamic> json) {
    final triggers = (json['requireApprovalOn'] as List<dynamic>?)
            ?.map((e) => e.toString())
            .toList() ??
        const [];
    return SecurityGateSummary(
      requireApprovalOn: triggers,
      approvalTimeoutMs: (json['approvalTimeoutMs'] as num?)?.toInt(),
      hasApprovalHandler: json['hasApprovalHandler'] as bool? ?? false,
      protectedFileRuleCount:
          (json['protectedFileRuleCount'] as num?)?.toInt() ?? 0,
    );
  }
}

