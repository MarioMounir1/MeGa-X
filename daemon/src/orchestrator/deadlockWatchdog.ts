export type DeadlockIssueType = 'DEADLOCK' | 'LIVELOCK' | 'STALLED_TASK';
export type DeadlockAction = 'ABORT' | 'FORCE_PASS' | 'FALLBACK_PRIMARY';

export interface DeadlockInspectionResult {
  healthy: boolean;
  detectedIssue?: DeadlockIssueType;
  taskId?: string;
  details?: string;
  durationMs: number;
  actionRecommended?: DeadlockAction;
}

export interface AgentTurnRecord {
  agentId: string;
  diffSignature: string;
  timestamp: number;
}

export interface TaskWatchdogState {
  taskId: string;
  startTime: number;
  lastActivityTime: number;
  turns: AgentTurnRecord[];
  waitingOnAgent?: string;
  holdingAgent?: string;
}

export interface DeadlockWatchdogConfig {
  maxStallDurationMs?: number;
  oscillationThreshold?: number;
}

export class AgentDeadlockWatchdog {
  private readonly maxStallDurationMs: number;
  private readonly oscillationThreshold: number;
  private tasks = new Map<string, TaskWatchdogState>();

  constructor(config: DeadlockWatchdogConfig = {}) {
    this.maxStallDurationMs = config.maxStallDurationMs ?? 60000;
    this.oscillationThreshold = config.oscillationThreshold ?? 3;
  }

  public trackTaskStart(taskId: string): void {
    const now = Date.now();
    this.tasks.set(taskId, {
      taskId,
      startTime: now,
      lastActivityTime: now,
      turns: [],
    });
  }

  public recordAgentTurn(
    taskId: string,
    agentId: string,
    diffSignature: string
  ): void {
    let state = this.tasks.get(taskId);
    const now = Date.now();
    if (!state) {
      state = {
        taskId,
        startTime: now,
        lastActivityTime: now,
        turns: [],
      };
      this.tasks.set(taskId, state);
    }

    state.lastActivityTime = now;
    state.turns.push({ agentId, diffSignature, timestamp: now });
  }

  public setAgentDependency(
    taskId: string,
    holdingAgent: string,
    waitingOnAgent: string
  ): void {
    let state = this.tasks.get(taskId);
    if (!state) {
      this.trackTaskStart(taskId);
      state = this.tasks.get(taskId)!;
    }
    state.holdingAgent = holdingAgent;
    state.waitingOnAgent = waitingOnAgent;
  }

  public inspect(taskId: string): DeadlockInspectionResult {
    const state = this.tasks.get(taskId);
    const now = Date.now();

    if (!state) {
      return {
        healthy: true,
        durationMs: 0,
      };
    }

    const durationMs = now - state.startTime;
    const inactiveMs = now - state.lastActivityTime;

    // 1. Check for Cyclic Dependency Deadlock
    if (
      state.holdingAgent &&
      state.waitingOnAgent &&
      state.holdingAgent === state.waitingOnAgent
    ) {
      return {
        healthy: false,
        detectedIssue: 'DEADLOCK',
        taskId,
        details: `Cyclic agent dependency detected: "${state.holdingAgent}" is waiting on itself.`,
        durationMs,
        actionRecommended: 'ABORT',
      };
    }

    // 2. Check for Livelock (Oscillating/repeating diff proposals)
    if (state.turns.length >= this.oscillationThreshold) {
      const recent = state.turns.slice(-this.oscillationThreshold);
      const signatures = recent.map((t) => t.diffSignature);
      const allSame = signatures.every((s) => s === signatures[0]);

      if (allSame) {
        return {
          healthy: false,
          detectedIssue: 'LIVELOCK',
          taskId,
          details: `Repeated identical diff proposal detected (${this.oscillationThreshold} consecutive occurrences).`,
          durationMs,
          actionRecommended: 'FALLBACK_PRIMARY',
        };
      }

      // Check alternating oscillation A -> B -> A -> B
      if (recent.length >= 4) {
        const s = recent.map((t) => t.diffSignature);
        if (s[0] === s[2] && s[1] === s[3] && s[0] !== s[1]) {
          return {
            healthy: false,
            detectedIssue: 'LIVELOCK',
            taskId,
            details: `Alternating diff oscillation detected between agents.`,
            durationMs,
            actionRecommended: 'FALLBACK_PRIMARY',
          };
        }
      }
    }

    // 3. Check for Stalled Task (Inactivity timeout)
    if (inactiveMs >= this.maxStallDurationMs) {
      return {
        healthy: false,
        detectedIssue: 'STALLED_TASK',
        taskId,
        details: `Task has been inactive for ${inactiveMs}ms (threshold: ${this.maxStallDurationMs}ms).`,
        durationMs,
        actionRecommended: 'ABORT',
      };
    }

    return {
      healthy: true,
      taskId,
      durationMs,
    };
  }

  public getTrackedTaskIds(): string[] {
    return Array.from(this.tasks.keys());
  }

  public clearTask(taskId: string): boolean {
    return this.tasks.delete(taskId);
  }

  public clearAll(): void {
    this.tasks.clear();
  }
}

