import * as fs from 'fs';
import * as path from 'path';
import {
  AgentResponse,
  AgentTaskPayload,
  FileDiff,
  IAgentAdapter,
} from '../types/contracts';
import { AgentRegistry } from './agentRegistry';

export interface ReplayInteraction {
  turn: number;
  promptSnippet?: string;
  hasErrorLog?: boolean;
  response: AgentResponse;
}

export interface FixtureData {
  name: string;
  version: string;
  interactions: ReplayInteraction[];
}

export interface PatternRule {
  pattern: string | RegExp;
  targetField?: 'prompt' | 'errorLog';
  response: (payload: AgentTaskPayload, turn: number) => AgentResponse;
}

/**
 * An AgentAdapter that replays scripted or recorded responses in strict sequential turn order.
 */
export class MockReplayAgentAdapter implements IAgentAdapter {
  public readonly agentId: string;
  private readonly interactions: ReplayInteraction[];
  private currentTurn = 0;
  private readonly fallback?: (payload: AgentTaskPayload, turn: number) => AgentResponse;

  constructor(
    agentId: string,
    interactions: ReplayInteraction[] = [],
    fallback?: (payload: AgentTaskPayload, turn: number) => AgentResponse
  ) {
    this.agentId = agentId;
    this.interactions = interactions;
    this.fallback = fallback;
  }

  public getTurnCount(): number {
    return this.currentTurn;
  }

  public resetTurnCount(): void {
    this.currentTurn = 0;
  }

  public addInteraction(interaction: ReplayInteraction): void {
    this.interactions.push(interaction);
  }

  public async plan(payload: AgentTaskPayload): Promise<AgentResponse> {
    return this.execute(payload);
  }

  public async execute(payload: AgentTaskPayload): Promise<AgentResponse> {
    this.currentTurn += 1;
    const match = this.interactions.find((i) => i.turn === this.currentTurn);

    if (match) {
      return {
        ...match.response,
        taskId: payload.taskId,
      };
    }

    if (this.fallback) {
      return this.fallback(payload, this.currentTurn);
    }

    return {
      taskId: payload.taskId,
      explanation: `[${this.agentId}] Replay interaction ended at turn ${this.currentTurn}.`,
      fileDiffs: [],
    };
  }

  public async review(
    payload: AgentTaskPayload,
    proposedDiffs: FileDiff[]
  ): Promise<{ approved: boolean; feedback?: string }> {
    return {
      approved: true,
      feedback: `[${this.agentId}] Replay verified ${proposedDiffs.length} diff(s). Approved.`,
    };
  }
}

/**
 * An AgentAdapter that dynamically matches rules on prompt keywords or self-healing error logs.
 */
export class PatternMatchMockAdapter implements IAgentAdapter {
  public readonly agentId: string;
  private readonly rules: PatternRule[];
  private executionCount = 0;

  constructor(agentId: string, rules: PatternRule[] = []) {
    this.agentId = agentId;
    this.rules = rules;
  }

  public addRule(rule: PatternRule): void {
    this.rules.push(rule);
  }

  public getExecutionCount(): number {
    return this.executionCount;
  }

  public async plan(payload: AgentTaskPayload): Promise<AgentResponse> {
    return {
      taskId: payload.taskId,
      explanation: `[${this.agentId}] PatternMatch planned execution.`,
      fileDiffs: [],
      microTasks: [payload.prompt],
    };
  }

  public async execute(payload: AgentTaskPayload): Promise<AgentResponse> {
    this.executionCount += 1;

    for (const rule of this.rules) {
      const targetText =
        rule.targetField === 'errorLog'
          ? (payload.errorLog ?? '')
          : payload.prompt;

      const matches =
        typeof rule.pattern === 'string'
          ? targetText.includes(rule.pattern)
          : rule.pattern.test(targetText);

      if (matches) {
        const resp = rule.response(payload, this.executionCount);
        return {
          ...resp,
          taskId: payload.taskId,
        };
      }
    }

    return {
      taskId: payload.taskId,
      explanation: `[${this.agentId}] No pattern matched for attempt ${this.executionCount}.`,
      fileDiffs: [],
    };
  }

  public async review(
    payload: AgentTaskPayload,
    proposedDiffs: FileDiff[]
  ): Promise<{ approved: boolean; feedback?: string }> {
    return {
      approved: true,
      feedback: `[${this.agentId}] PatternMatch approved ${proposedDiffs.length} diffs.`,
    };
  }
}

/**
 * Serializes and saves a replay fixture to disk.
 */
export function saveReplayFixture(targetPath: string, fixture: FixtureData): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(targetPath, JSON.stringify(fixture, null, 2) + '\n', 'utf-8');
}

/**
 * Reads a replay fixture from disk.
 */
export function loadReplayFixture(sourcePath: string): FixtureData {
  const raw = fs.readFileSync(sourcePath, 'utf-8');
  return JSON.parse(raw) as FixtureData;
}

/**
 * Creates an AgentRegistry loaded with deterministic self-healing replay sequences for CI testing.
 */
export function createDeterministicReplayRegistry(options?: {
  failingCode?: string;
  healingCode?: string;
  targetFile?: string;
}): AgentRegistry {
  const file = options?.targetFile ?? 'src/index.ts';
  const brokenCode = options?.failingCode ?? 'export const value: number = "broken";';
  const fixedCode = options?.healingCode ?? 'export const value: number = 42;';

  const registry = new AgentRegistry();

  const mockAgent = new MockReplayAgentAdapter('claude-3-7-sonnet', [
    {
      turn: 1,
      response: {
        taskId: '',
        explanation: 'Turn 1: Producing broken code to test self-healing loop',
        fileDiffs: [{ path: file, content: brokenCode, action: 'CREATE' }],
        microTasks: ['Step 1: Write broken code'],
      },
    },
    {
      turn: 2,
      response: {
        taskId: '',
        explanation: 'Turn 2: Reading error log and healing code',
        fileDiffs: [{ path: file, content: fixedCode, action: 'UPDATE' }],
        microTasks: ['Step 2: Fix type error'],
      },
    },
  ]);

  registry.register(mockAgent);
  registry.register(new MockReplayAgentAdapter('antigravity', [
    {
      turn: 1,
      response: {
        taskId: '',
        explanation: 'Executor Turn 1',
        fileDiffs: [{ path: file, content: fixedCode, action: 'CREATE' }],
      },
    },
  ]));
  registry.register(new MockReplayAgentAdapter('codex'));

  return registry;
}

