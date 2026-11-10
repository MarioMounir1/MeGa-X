import { AgentRegistry } from '../agents/agentRegistry';
import { GitManager } from '../git/gitManager';
import { FilePatcher } from '../patcher/filePatcher';
import { WorkspaceScanner } from '../patcher/workspaceScanner';
import { ApprovalHandler, SecurityGate } from '../security/securityGate';
import { TaskAuditStore } from '../storage/taskAuditStore';
import {
  AgentTaskPayload,
  ContextFile,
  EngineMode,
  MegaXConfig,
  TaskState,
} from '../types/contracts';
import {
  TerminalStreamListener,
  VerificationRunner,
} from '../verifier/verificationRunner';

export interface TaskStateChangeEvent {
  taskId: string;
  state: TaskState;
  attempt: number;
  message: string;
  timestamp: string;
}

export type StateChangeListener = (event: TaskStateChangeEvent) => void;

export interface MicroTaskExecutionResult {
  taskId: string;
  prompt: string;
  branchName: string;
  status: 'COMPLETED' | 'FAILED' | 'ROLLED_BACK';
  attemptsUsed: number;
  commitHash?: string | null;
  failureReason?: string;
  lastErrorLog?: string;
}

export interface OrchestrationRunResult {
  masterTaskId: string;
  engineMode: MegaXConfig['engineMode'];
  overallSuccess: boolean;
  microTaskResults: MicroTaskExecutionResult[];
}

export interface OrchestratorOptions {
  workspaceRoot: string;
  config: MegaXConfig;
  agentRegistry?: AgentRegistry;
  onStream?: TerminalStreamListener;
  onStateChange?: StateChangeListener;
  onApprovalRequest?: ApprovalHandler;
}

export class OrchestratorEngine {
  private readonly workspaceRoot: string;
  private config: MegaXConfig;
  private readonly registry: AgentRegistry;
  private readonly gitManager: GitManager;
  private readonly filePatcher: FilePatcher;
  private readonly workspaceScanner: WorkspaceScanner;
  private readonly auditStore: TaskAuditStore;
  private readonly securityGate: SecurityGate;
  private readonly verificationRunner: VerificationRunner;
  private stateListener?: StateChangeListener;
  private lastStateEvent: TaskStateChangeEvent | null = null;
  private abortRequested = false;

  constructor(options: OrchestratorOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.config = options.config;
    this.registry = options.agentRegistry ?? new AgentRegistry();
    this.gitManager = new GitManager(this.workspaceRoot);
    this.filePatcher = new FilePatcher(this.workspaceRoot);
    this.workspaceScanner = new WorkspaceScanner(this.workspaceRoot);
    this.auditStore = new TaskAuditStore(this.workspaceRoot);
    this.securityGate = new SecurityGate(
      this.config.security,
      options.onApprovalRequest
    );
    this.verificationRunner = new VerificationRunner(
      this.workspaceRoot,
      this.config.verification,
      options.onStream
    );
    this.stateListener = options.onStateChange;
  }

  public getAuditStore(): TaskAuditStore {
    return this.auditStore;
  }

  public getWorkspaceScanner(): WorkspaceScanner {
    return this.workspaceScanner;
  }

  public getFilePatcher(): FilePatcher {
    return this.filePatcher;
  }

  public getGitManager(): GitManager {
    return this.gitManager;
  }

  public getConfig(): MegaXConfig {
    return { ...this.config };
  }

  /**
   * Dynamically switches the Daemon between SINGLE_AGENT and MULTI_AGENT mode at runtime.
   */
  public setEngineMode(engineMode: EngineMode): MegaXConfig {
    if (engineMode !== 'SINGLE_AGENT' && engineMode !== 'MULTI_AGENT') {
      throw new Error(`Invalid engineMode: ${String(engineMode)}`);
    }
    this.config = {
      ...this.config,
      engineMode,
    };
    return this.getConfig();
  }

  /**
   * Hot-reloads a complete MegaXConfig into the OrchestratorEngine, SecurityGate, and VerificationRunner.
   */
  public updateConfig(newConfig: MegaXConfig): MegaXConfig {
    this.config = { ...newConfig };
    this.securityGate.setRequiredTriggers(
      newConfig.security.requireApprovalOn
    );
    this.verificationRunner.setVerificationConfig(newConfig.verification);
    return this.getConfig();
  }

  /**
   * Emergency Kill-Switch: Aborts the active task and kills any running verification child process.
   */
  public abortActiveTask(): void {
    this.abortRequested = true;
    this.verificationRunner.abortActiveProcess();
  }

  public getAgentRegistry(): AgentRegistry {
    return this.registry;
  }

  public getSecurityGate(): SecurityGate {
    return this.securityGate;
  }

  public getVerificationRunner(): VerificationRunner {
    return this.verificationRunner;
  }

  public setStateChangeListener(listener: StateChangeListener): void {
    this.stateListener = listener;
  }

  public getLastStateEvent(): TaskStateChangeEvent | null {
    return this.lastStateEvent ? { ...this.lastStateEvent } : null;
  }

  private emitState(
    taskId: string,
    state: TaskState,
    attempt: number,
    message: string
  ): void {
    const evt: TaskStateChangeEvent = {
      taskId,
      state,
      attempt,
      message,
      timestamp: new Date().toISOString(),
    };
    this.lastStateEvent = evt;
    if (!this.stateListener) {
      return;
    }
    this.stateListener(evt);
  }

  /**
   * Executes a high-level feature prompt end-to-end according to engineMode:
   * - SINGLE_AGENT: Primary Agent plans (or executes directly) -> Self-Healing Loop -> Git Commit / Rollback
   * - MULTI_AGENT : Planner breaks into micro-tasks -> Executor codes -> Verifier runs tests -> Reviewer inspects -> Git Commit / Rollback
   */
  public async runFeaturePrompt(
    masterTaskId: string,
    prompt: string,
    contextFilePaths: string[] = []
  ): Promise<OrchestrationRunResult> {
    const { planner } = this.registry.resolveRoleAdapters(this.config);

    this.emitState(
      masterTaskId,
      'PLANNING',
      0,
      `Planning task "${masterTaskId}" using ${planner.agentId} (${this.config.engineMode})`
    );

    const initialContext =
      contextFilePaths.length > 0
        ? this.filePatcher.readContextFiles(contextFilePaths)
        : this.workspaceScanner.discoverContextForPrompt(prompt);

    const planResponse = await planner.plan({
      taskId: masterTaskId,
      prompt,
      contextFiles: initialContext,
    });

    const microPrompts =
      planResponse.microTasks && planResponse.microTasks.length > 0
        ? planResponse.microTasks
        : [prompt];

    const microTaskResults: MicroTaskExecutionResult[] = [];
    let overallSuccess = true;

    for (let i = 0; i < microPrompts.length; i++) {
      const subTaskId =
        microPrompts.length === 1
          ? masterTaskId
          : `${masterTaskId}_sub_${i + 1}`;
      const subPrompt = microPrompts[i];

      const currentContext =
        contextFilePaths.length > 0
          ? this.filePatcher.readContextFiles(contextFilePaths)
          : this.workspaceScanner.discoverContextForPrompt(subPrompt);
      const subResult = await this.executeMicroTask(
        subTaskId,
        subPrompt,
        currentContext
      );
      microTaskResults.push(subResult);

      if (subResult.status !== 'COMPLETED') {
        overallSuccess = false;
        break;
      }
    }

    const finalResult: OrchestrationRunResult = {
      masterTaskId,
      engineMode: this.config.engineMode,
      overallSuccess,
      microTaskResults,
    };

    this.auditStore.recordRun(prompt, finalResult);
    return finalResult;
  }

  /**
   * Runs a single atomic task on an isolated Git branch (`megax/<taskId>`)
   * with up to `maxFixAttempts` self-healing retries.
   */
  public async executeMicroTask(
    taskId: string,
    prompt: string,
    contextFiles: ContextFile[] = []
  ): Promise<MicroTaskExecutionResult> {
    const { executor, reviewer } = this.registry.resolveRoleAdapters(
      this.config
    );
    const maxAttempts = this.config.verification.maxFixAttempts;
    const isGitRepo = this.gitManager.isGitRepository();
    this.abortRequested = false;

    const baseBranch = isGitRepo ? this.gitManager.getCurrentBranch() : 'main';
    const branchName = isGitRepo
      ? this.gitManager.createTaskBranch(taskId)
      : GitManager.formatTaskBranchName(taskId);

    let lastErrorLog: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const stateForAttempt: TaskState =
        attempt === 1 ? 'EXECUTING' : 'SELF_HEALING';
      this.emitState(
        taskId,
        stateForAttempt,
        attempt,
        attempt === 1
          ? `Executing task on branch ${branchName} via ${executor.agentId}`
          : `Self-healing attempt ${attempt}/${maxAttempts} via ${executor.agentId}`
      );

      const payload: AgentTaskPayload = {
        taskId,
        prompt,
        contextFiles,
        errorLog: lastErrorLog,
      };

      const agentResponse = await executor.execute(payload);

      // 1. Pre-Patch Security Gate Check (FILE_DELETE, DB_MIGRATION)
      const diffTriggers = this.securityGate.detectDiffTriggers(
        agentResponse.fileDiffs
      );
      if (diffTriggers.length > 0) {
        this.emitState(
          taskId,
          'AWAITING_APPROVAL',
          attempt,
          `Awaiting mobile approval for: ${diffTriggers
            .map((t) => t.trigger)
            .join(', ')}`
        );
      }

      const gateDecision = await this.securityGate.verifyDiffsOrWait(
        taskId,
        agentResponse.fileDiffs
      );

      if (!gateDecision.approved) {
        this.emitState(
          taskId,
          'ROLLING_BACK',
          attempt,
          `Security Gate rejected (${gateDecision.rejectedBy}): ${
            gateDecision.note ?? 'No reason provided'
          }`
        );
        if (isGitRepo) {
          this.gitManager.hardRollback({
            returnBranch: baseBranch,
            deleteTaskBranch: branchName,
          });
        }
        this.emitState(taskId, 'FAILED', attempt, 'Task aborted by Security Gate');
        return {
          taskId,
          prompt,
          branchName,
          status: 'ROLLED_BACK',
          attemptsUsed: attempt,
          failureReason: `Rejected by Security Gate (${gateDecision.rejectedBy})`,
          lastErrorLog,
        };
      }

      // 2. Apply FileDiff[] to workspace
      this.filePatcher.applyDiffs(agentResponse.fileDiffs);

      // 3. Run Verification Suite (compileCommand + testCommand)
      this.emitState(
        taskId,
        'VERIFYING',
        attempt,
        `Running verification suite (Attempt ${attempt}/${maxAttempts})`
      );
      const verification = await this.verificationRunner.runVerificationSuite(
        taskId,
        attempt
      );

      if (this.abortRequested) {
        this.emitState(
          taskId,
          'ROLLING_BACK',
          attempt,
          'Emergency abort triggered by user. Executing hard Git rollback.'
        );
        if (isGitRepo) {
          this.gitManager.hardRollback({
            returnBranch: baseBranch,
            deleteTaskBranch: branchName,
          });
        }
        this.emitState(
          taskId,
          'FAILED',
          attempt,
          'Task aborted via Mobile Kill-Switch.'
        );
        return {
          taskId,
          prompt,
          branchName,
          status: 'ROLLED_BACK',
          attemptsUsed: attempt,
          failureReason: 'Aborted by user via Mobile Kill-Switch',
          lastErrorLog: verification.errorLog,
        };
      }

      if (!verification.passed) {
        lastErrorLog = verification.errorLog;
        continue;
      }

      // 4. Optional Multi-Agent Reviewer check
      if (
        this.config.engineMode === 'MULTI_AGENT' &&
        reviewer &&
        typeof reviewer.review === 'function'
      ) {
        this.emitState(
          taskId,
          'REVIEWING',
          attempt,
          `Reviewing changes via ${reviewer.agentId}`
        );
        const reviewResult = await reviewer.review(
          payload,
          agentResponse.fileDiffs
        );
        if (!reviewResult.approved) {
          lastErrorLog = [
            `=== MULTI-AGENT REVIEWER REJECTION (Attempt ${attempt}/${maxAttempts}) ===`,
            `Reviewer (${reviewer.agentId}) Feedback:`,
            reviewResult.feedback ?? 'Changes did not pass code review.',
          ].join('\n');
          continue;
        }
      }

      // 5. Commit verified changes
      this.emitState(
        taskId,
        'COMMITTING',
        attempt,
        `Verification passed on attempt ${attempt}. Committing to ${branchName}.`
      );
      const commitHash = isGitRepo
        ? this.gitManager.commitAll(
            `feat(${taskId}): ${agentResponse.explanation || prompt}`
          )
        : null;

      this.emitState(
        taskId,
        'COMPLETED',
        attempt,
        `Task ${taskId} completed and committed (${commitHash ?? 'no-git'}).`
      );

      return {
        taskId,
        prompt,
        branchName,
        status: 'COMPLETED',
        attemptsUsed: attempt,
        commitHash,
      };
    }

    // Max retries exceeded -> Notify Mobile Controller if MAX_RETRY_EXCEEDED is configured, then hard rollback
    if (this.securityGate.isTriggerEnabled('MAX_RETRY_EXCEEDED')) {
      this.emitState(
        taskId,
        'AWAITING_APPROVAL',
        maxAttempts,
        `Max fix attempts (${maxAttempts}) exceeded. Notifying Mobile Controller.`
      );
      await this.securityGate.requestApproval(
        taskId,
        'MAX_RETRY_EXCEEDED',
        `Task "${taskId}" failed verification after ${maxAttempts} attempts. Rolling back branch ${branchName}.`,
        []
      );
    }

    this.emitState(
      taskId,
      'ROLLING_BACK',
      maxAttempts,
      `Max attempts (${maxAttempts}) exhausted. Executing git reset --hard rollback.`
    );

    if (isGitRepo) {
      this.gitManager.hardRollback({
        returnBranch: baseBranch,
        deleteTaskBranch: branchName,
      });
    }

    this.emitState(
      taskId,
      'FAILED',
      maxAttempts,
      `Task ${taskId} rolled back after ${maxAttempts} failed attempts.`
    );

    return {
      taskId,
      prompt,
      branchName,
      status: 'ROLLED_BACK',
      attemptsUsed: maxAttempts,
      failureReason: `Exceeded maxFixAttempts (${maxAttempts})`,
      lastErrorLog,
    };
  }
}

