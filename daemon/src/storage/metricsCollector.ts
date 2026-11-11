import { AuditLogEntry, TaskAuditStore } from './taskAuditStore';

export interface DaemonMetricsSummary {
  totalRuns: number;
  successfulRuns: number;
  failedOrRolledBackRuns: number;
  successRatePercent: number;
  totalMicroTasks: number;
  firstAttemptPasses: number;
  selfHealedPasses: number;
  rolledBackMicroTasks: number;
  averageAttemptsPerTask: number;
  modeBreakdown?: {
    singleAgentRuns: number;
    multiAgentRuns: number;
  };
  recentHistoryWindow?: number;
}

/**
 * Computes real-time orchestration and self-healing performance metrics
 * from recorded TaskAuditStore entries.
 */
export class TelemetryMetricsCollector {
  private readonly auditStore: TaskAuditStore;

  constructor(auditStore: TaskAuditStore) {
    this.auditStore = auditStore;
  }

  public static computeFromEntries(
    entries: AuditLogEntry[]
  ): DaemonMetricsSummary {
    const totalRuns = entries.length;
    let successfulRuns = 0;
    let failedOrRolledBackRuns = 0;

    let totalMicroTasks = 0;
    let firstAttemptPasses = 0;
    let selfHealedPasses = 0;
    let rolledBackMicroTasks = 0;
    let totalAttemptsSum = 0;
    let singleAgentRuns = 0;
    let multiAgentRuns = 0;

    for (const run of entries) {
      if (run.engineMode === 'SINGLE_AGENT') {
        singleAgentRuns++;
      } else if (run.engineMode === 'MULTI_AGENT') {
        multiAgentRuns++;
      }

      if (run.overallSuccess) {
        successfulRuns++;
      } else {
        failedOrRolledBackRuns++;
      }

      for (const task of run.microTaskResults) {
        totalMicroTasks++;
        totalAttemptsSum += task.attemptsUsed;

        if (task.status === 'COMPLETED') {
          if (task.attemptsUsed === 1) {
            firstAttemptPasses++;
          } else {
            selfHealedPasses++;
          }
        } else {
          rolledBackMicroTasks++;
        }
      }
    }

    const successRatePercent =
      totalRuns === 0 ? 100 : Math.round((successfulRuns / totalRuns) * 100);
    const averageAttemptsPerTask =
      totalMicroTasks === 0
        ? 0
        : Number((totalAttemptsSum / totalMicroTasks).toFixed(2));

    return {
      totalRuns,
      successfulRuns,
      failedOrRolledBackRuns,
      successRatePercent,
      totalMicroTasks,
      firstAttemptPasses,
      selfHealedPasses,
      rolledBackMicroTasks,
      averageAttemptsPerTask,
      modeBreakdown: {
        singleAgentRuns,
        multiAgentRuns,
      },
      recentHistoryWindow: entries.length,
    };
  }

  public getMetricsSummary(options?: {
    engineMode?: 'SINGLE_AGENT' | 'MULTI_AGENT';
    limit?: number;
  }): DaemonMetricsSummary {
    let entries = this.auditStore.readAll();
    if (options?.engineMode) {
      entries = entries.filter((e) => e.engineMode === options.engineMode);
    }
    if (
      typeof options?.limit === 'number' &&
      !Number.isNaN(options.limit) &&
      options.limit > 0
    ) {
      entries = entries.slice(-options.limit);
    }
    return TelemetryMetricsCollector.computeFromEntries(entries);
  }
}

