import {
  AgentResponse,
  AgentTaskPayload,
  FileDiff,
  IAgentAdapter,
  MegaXConfig,
} from '../types/contracts';

export interface ScriptedAgentHandlers {
  onPlan?: (payload: AgentTaskPayload) => Promise<AgentResponse> | AgentResponse;
  onExecute?: (
    payload: AgentTaskPayload
  ) => Promise<AgentResponse> | AgentResponse;
  onReview?: (
    payload: AgentTaskPayload,
    proposedDiffs: FileDiff[]
  ) =>
    | Promise<{ approved: boolean; feedback?: string }>
    | { approved: boolean; feedback?: string };
}

/**
 * Configurable Agent Adapter that can wrap custom model handlers or default behaviors
 * for Claude 3.7, AntiGravity, Codex, or test mocks.
 */
export class ConfigurableAgentAdapter implements IAgentAdapter {
  public readonly agentId: string;
  private readonly handlers: ScriptedAgentHandlers;

  constructor(agentId: string, handlers: ScriptedAgentHandlers = {}) {
    this.agentId = agentId;
    this.handlers = handlers;
  }

  public async plan(payload: AgentTaskPayload): Promise<AgentResponse> {
    if (this.handlers.onPlan) {
      return this.handlers.onPlan(payload);
    }
    return {
      taskId: payload.taskId,
      explanation: `[${this.agentId}] Generated default single-step execution plan.`,
      fileDiffs: [],
      microTasks: [payload.prompt],
    };
  }

  public async execute(payload: AgentTaskPayload): Promise<AgentResponse> {
    if (this.handlers.onExecute) {
      return this.handlers.onExecute(payload);
    }
    return {
      taskId: payload.taskId,
      explanation: `[${this.agentId}] Executed task ${payload.taskId}.`,
      fileDiffs: [],
    };
  }

  public async review(
    payload: AgentTaskPayload,
    proposedDiffs: FileDiff[]
  ): Promise<{ approved: boolean; feedback?: string }> {
    if (this.handlers.onReview) {
      return this.handlers.onReview(payload, proposedDiffs);
    }
    return {
      approved: true,
      feedback: `[${this.agentId}] Verified ${proposedDiffs.length} file diff(s). LGTM.`,
    };
  }
}

export class AgentRegistry {
  private readonly adapters = new Map<string, IAgentAdapter>();

  constructor() {
    // Register default built-in adapters so config names resolve out of the box
    this.register(new ConfigurableAgentAdapter('claude-3-7-sonnet'));
    this.register(new ConfigurableAgentAdapter('antigravity'));
    this.register(new ConfigurableAgentAdapter('codex'));
  }

  public register(adapter: IAgentAdapter): void {
    this.adapters.set(adapter.agentId, adapter);
  }

  public get(agentId: string): IAgentAdapter {
    const adapter = this.adapters.get(agentId);
    if (!adapter) {
      throw new Error(
        `Agent adapter "${agentId}" is not registered in AgentRegistry.`
      );
    }
    return adapter;
  }

  /**
   * Resolves the Planner, Executor, and optional Reviewer adapters based on engineMode.
   */
  public resolveRoleAdapters(config: MegaXConfig): {
    planner: IAgentAdapter;
    executor: IAgentAdapter;
    reviewer?: IAgentAdapter;
  } {
    if (config.engineMode === 'SINGLE_AGENT') {
      const primary = this.get(config.primaryAgent);
      return {
        planner: primary,
        executor: primary,
      };
    }

    return {
      planner: this.get(config.multiAgentConfig.planner),
      executor: this.get(config.multiAgentConfig.executor),
      reviewer: this.get(config.multiAgentConfig.reviewer),
    };
  }
}

