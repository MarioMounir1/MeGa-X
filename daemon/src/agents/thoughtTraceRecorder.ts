export type ThoughtCategory =
  | 'PLANNING'
  | 'ANALYSIS'
  | 'DECISION'
  | 'CRITIQUE'
  | 'VERIFICATION';

export interface ThoughtTraceStep {
  stepIndex: number;
  taskId: string;
  agentId: string;
  category: ThoughtCategory;
  content: string;
  timestamp: string;
}

export interface ThoughtTraceSummary {
  taskId: string;
  totalSteps: number;
  agentsInvolved: string[];
  steps: ThoughtTraceStep[];
}

export class ThoughtTraceRecorder {
  private static sharedTraces = new Map<string, ThoughtTraceStep[]>();
  private readonly traces: Map<string, ThoughtTraceStep[]>;

  constructor(customMap?: Map<string, ThoughtTraceStep[]>) {
    this.traces = customMap ?? ThoughtTraceRecorder.sharedTraces;
  }

  public recordStep(params: {
    taskId: string;
    agentId: string;
    category: ThoughtCategory;
    content: string;
  }): ThoughtTraceStep {
    const list = this.traces.get(params.taskId) ?? [];
    const step: ThoughtTraceStep = {
      ...params,
      stepIndex: list.length + 1,
      timestamp: new Date().toISOString(),
    };

    list.push(step);
    this.traces.set(params.taskId, list);
    return step;
  }

  public getTrace(taskId: string, limit?: number): ThoughtTraceSummary {
    const all = this.traces.get(taskId) ?? [];
    const steps = limit ? all.slice(-limit) : [...all];
    const agentsInvolved = Array.from(new Set(all.map((s) => s.agentId)));

    return {
      taskId,
      totalSteps: all.length,
      agentsInvolved,
      steps,
    };
  }

  public listActiveTaskTraces(): string[] {
    return Array.from(this.traces.keys());
  }

  public clearTrace(taskId: string): boolean {
    return this.traces.delete(taskId);
  }

  public clearAll(): void {
    this.traces.clear();
  }
}
