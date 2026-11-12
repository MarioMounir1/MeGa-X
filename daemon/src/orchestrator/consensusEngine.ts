import { FileDiff } from '../types/contracts';

export type ConsensusStatus =
  | 'UNANIMOUS_APPROVAL'
  | 'MAJORITY_APPROVAL'
  | 'CONFLICT_DETECTED'
  | 'UNANIMOUS_REJECTION';

export interface AgentVote {
  agentId: string;
  role: 'PLANNER' | 'EXECUTOR' | 'REVIEWER';
  approved: boolean;
  score?: number; // 0.0 - 1.0 quality / confidence
  feedback?: string;
  proposedAlternativeDiffs?: FileDiff[];
}

export interface ConsensusEvaluation {
  taskId: string;
  status: ConsensusStatus;
  approvalRatio: number;
  votes: AgentVote[];
  conflictingFiles: string[];
  resolvedDiffs?: FileDiff[];
  requiresMobileEscalation: boolean;
  resolutionStrategyApplied: 'DIRECT_PASS' | 'SYNTHESIS' | 'QUORUM' | 'ESCALATED';
  evaluatedAt: string;
}

/**
 * Multi-Agent Consensus & Conflict Resolution Engine for MeGa X.
 */
export class AgentConsensusEngine {
  private readonly evaluations: ConsensusEvaluation[] = [];
  private readonly maxBufferSize: number;

  constructor(maxBufferSize = 100) {
    this.maxBufferSize = maxBufferSize;
  }

  /**
   * Evaluates votes from participating agents and detects file diff conflicts.
   */
  public evaluateVotes(
    taskId: string,
    originalDiffs: FileDiff[],
    votes: AgentVote[],
    quorumThreshold = 0.5
  ): ConsensusEvaluation {
    if (votes.length === 0) {
      const evaluation: ConsensusEvaluation = {
        taskId,
        status: 'UNANIMOUS_APPROVAL',
        approvalRatio: 1.0,
        votes: [],
        conflictingFiles: [],
        resolvedDiffs: originalDiffs,
        requiresMobileEscalation: false,
        resolutionStrategyApplied: 'DIRECT_PASS',
        evaluatedAt: new Date().toISOString(),
      };
      this.recordEvaluation(evaluation);
      return evaluation;
    }

    const approvedVotes = votes.filter((v) => v.approved);
    const approvalRatio = approvedVotes.length / votes.length;

    // Detect conflicting alternative file proposals
    const originalPaths = new Set(originalDiffs.map((d) => d.path));
    const conflictingFilesSet = new Set<string>();

    for (const vote of votes) {
      if (vote.proposedAlternativeDiffs && vote.proposedAlternativeDiffs.length > 0) {
        for (const alt of vote.proposedAlternativeDiffs) {
          if (originalPaths.has(alt.path)) {
            const orig = originalDiffs.find((d) => d.path === alt.path);
            if (orig && orig.content !== alt.content) {
              conflictingFilesSet.add(alt.path);
            }
          }
        }
      }
    }

    const conflictingFiles = Array.from(conflictingFilesSet);

    let status: ConsensusStatus;
    let strategy: ConsensusEvaluation['resolutionStrategyApplied'] = 'DIRECT_PASS';
    let requiresEscalation = false;

    if (conflictingFiles.length > 0) {
      status = 'CONFLICT_DETECTED';
      strategy = 'ESCALATED';
      requiresEscalation = true;
    } else if (approvalRatio === 1.0) {
      status = 'UNANIMOUS_APPROVAL';
      strategy = 'DIRECT_PASS';
    } else if (approvalRatio >= quorumThreshold) {
      status = 'MAJORITY_APPROVAL';
      strategy = 'QUORUM';
    } else if (approvalRatio === 0) {
      status = 'UNANIMOUS_REJECTION';
      strategy = 'ESCALATED';
      requiresEscalation = true;
    } else {
      status = 'CONFLICT_DETECTED';
      strategy = 'ESCALATED';
      requiresEscalation = true;
    }

    const evaluation: ConsensusEvaluation = {
      taskId,
      status,
      approvalRatio,
      votes,
      conflictingFiles,
      resolvedDiffs: status === 'UNANIMOUS_APPROVAL' || status === 'MAJORITY_APPROVAL'
        ? originalDiffs
        : undefined,
      requiresMobileEscalation: requiresEscalation,
      resolutionStrategyApplied: strategy,
      evaluatedAt: new Date().toISOString(),
    };

    this.recordEvaluation(evaluation);
    return evaluation;
  }

  /**
   * Resolves a conflict by synthesis using a custom synthesizer callback.
   */
  public async resolveConflict(
    evaluation: ConsensusEvaluation,
    synthesizer: (evalData: ConsensusEvaluation) => Promise<FileDiff[]>
  ): Promise<ConsensusEvaluation> {
    if (evaluation.status === 'UNANIMOUS_APPROVAL' || evaluation.status === 'MAJORITY_APPROVAL') {
      return evaluation;
    }

    try {
      const synthesizedDiffs = await synthesizer(evaluation);
      const updated: ConsensusEvaluation = {
        ...evaluation,
        status: 'MAJORITY_APPROVAL',
        resolvedDiffs: synthesizedDiffs,
        requiresMobileEscalation: false,
        resolutionStrategyApplied: 'SYNTHESIS',
        evaluatedAt: new Date().toISOString(),
      };
      this.recordEvaluation(updated);
      return updated;
    } catch {
      // Failed to synthesize, retain escalation requirement
      return evaluation;
    }
  }

  public recordEvaluation(evaluation: ConsensusEvaluation): void {
    this.evaluations.push(evaluation);
    if (this.evaluations.length > this.maxBufferSize) {
      this.evaluations.shift();
    }
  }

  public getRecentEvaluations(limit = 50): ConsensusEvaluation[] {
    return this.evaluations.slice(-limit).reverse();
  }

  public getEvaluationForTask(taskId: string): ConsensusEvaluation | null {
    for (let i = this.evaluations.length - 1; i >= 0; i--) {
      if (this.evaluations[i].taskId === taskId) {
        return this.evaluations[i];
      }
    }
    return null;
  }

  public clear(): void {
    this.evaluations.length = 0;
  }
}

