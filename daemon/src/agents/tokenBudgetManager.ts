export interface TokenUsageRecord {
  agentId: string;
  taskId: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  timestamp: string;
}

export interface BudgetLimits {
  maxTotalTokens?: number;
  maxCostUsd?: number;
  maxTaskTokens?: number;
}

export interface BudgetSummary {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalEstimatedCostUsd: number;
  recordsCount: number;
  limits: BudgetLimits;
  isBudgetExceeded: boolean;
  exceededReason?: string;
}

const MODEL_COSTS: Record<string, { promptPerM: number; completionPerM: number }> = {
  'claude-3-7-sonnet': { promptPerM: 3.0, completionPerM: 15.0 },
  'antigravity': { promptPerM: 1.25, completionPerM: 5.0 },
  'codex': { promptPerM: 2.5, completionPerM: 10.0 },
};

export class TokenBudgetManager {
  private records: TokenUsageRecord[] = [];
  private limits: BudgetLimits = {};

  constructor(initialLimits?: BudgetLimits) {
    if (initialLimits) {
      this.limits = { ...initialLimits };
    }
  }

  public calculateCost(agentId: string, promptTokens: number, completionTokens: number): number {
    const rates = MODEL_COSTS[agentId] ?? { promptPerM: 2.0, completionPerM: 8.0 };
    const promptCost = (promptTokens / 1_000_000) * rates.promptPerM;
    const completionCost = (completionTokens / 1_000_000) * rates.completionPerM;
    return Number((promptCost + completionCost).toFixed(6));
  }

  public recordUsage(params: {
    agentId: string;
    taskId: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
  }): TokenUsageRecord {
    const estimatedCostUsd = this.calculateCost(
      params.agentId,
      params.promptTokens,
      params.completionTokens
    );

    const record: TokenUsageRecord = {
      ...params,
      estimatedCostUsd,
      timestamp: new Date().toISOString(),
    };

    this.records.push(record);
    return record;
  }

  public setLimits(limits: BudgetLimits): void {
    this.limits = { ...this.limits, ...limits };
  }

  public getLimits(): BudgetLimits {
    return { ...this.limits };
  }

  public getRecords(taskId?: string): TokenUsageRecord[] {
    if (!taskId) return [...this.records];
    return this.records.filter((r) => r.taskId === taskId);
  }

  public reset(): void {
    this.records = [];
  }

  public checkBudget(proposedPromptTokens = 0): { allowed: boolean; reason?: string } {
    const summary = this.getSummary();
    const prospectiveTotalTokens = summary.totalTokens + proposedPromptTokens;

    if (this.limits.maxTotalTokens && prospectiveTotalTokens > this.limits.maxTotalTokens) {
      return {
        allowed: false,
        reason: `Exceeded total token budget limit of ${this.limits.maxTotalTokens} (projected: ${prospectiveTotalTokens})`,
      };
    }

    if (this.limits.maxCostUsd && summary.totalEstimatedCostUsd > this.limits.maxCostUsd) {
      return {
        allowed: false,
        reason: `Exceeded cost budget limit of $${this.limits.maxCostUsd} (current: $${summary.totalEstimatedCostUsd})`,
      };
    }

    return { allowed: true };
  }

  public getSummary(): BudgetSummary {
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalEstimatedCostUsd = 0;

    for (const r of this.records) {
      totalPromptTokens += r.promptTokens;
      totalCompletionTokens += r.completionTokens;
      totalEstimatedCostUsd += r.estimatedCostUsd;
    }

    const totalTokens = totalPromptTokens + totalCompletionTokens;
    let isBudgetExceeded = false;
    let exceededReason: string | undefined;

    if (this.limits.maxTotalTokens && totalTokens > this.limits.maxTotalTokens) {
      isBudgetExceeded = true;
      exceededReason = `Token limit of ${this.limits.maxTotalTokens} exceeded (${totalTokens} tokens recorded)`;
    } else if (this.limits.maxCostUsd && totalEstimatedCostUsd > this.limits.maxCostUsd) {
      isBudgetExceeded = true;
      exceededReason = `Cost limit of $${this.limits.maxCostUsd} exceeded ($${Number(totalEstimatedCostUsd.toFixed(4))} spent)`;
    }

    return {
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens,
      totalEstimatedCostUsd: Number(totalEstimatedCostUsd.toFixed(6)),
      recordsCount: this.records.length,
      limits: { ...this.limits },
      isBudgetExceeded,
      exceededReason,
    };
  }
}

