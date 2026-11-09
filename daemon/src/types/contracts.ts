/**
 * PROJECT MeGa X - UNIFIED DATA CONTRACTS & CONFIGURATION SCHEMAS
 */

export type FileAction = 'CREATE' | 'UPDATE' | 'DELETE';

export interface FileDiff {
  path: string;
  content: string;
  action: FileAction;
}

export interface ContextFile {
  path: string;
  content: string;
}

export interface AgentTaskPayload {
  taskId: string;
  prompt: string;
  contextFiles?: ContextFile[];
  errorLog?: string; // Captured Stack Trace provided during Self-Healing retry loops
}

export interface AgentResponse {
  taskId: string;
  explanation: string;
  fileDiffs: FileDiff[];
  microTasks?: string[]; // Populated only during Planning phase
}

export type EngineMode = 'SINGLE_AGENT' | 'MULTI_AGENT';

export type ApprovalTrigger =
  | 'DB_MIGRATION'
  | 'FILE_DELETE'
  | 'MAX_RETRY_EXCEEDED';

export type TaskState =
  | 'IDLE'
  | 'PLANNING'
  | 'AWAITING_APPROVAL'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'SELF_HEALING'
  | 'REVIEWING'
  | 'COMMITTING'
  | 'ROLLING_BACK'
  | 'COMPLETED'
  | 'FAILED';

export interface MultiAgentConfig {
  planner: string;
  executor: string;
  reviewer: string;
}

export interface VerificationConfig {
  testCommand: string;
  compileCommand: string;
  maxFixAttempts: number;
}

export interface SecurityConfig {
  requireApprovalOn: ApprovalTrigger[];
}

export interface MegaXConfig {
  projectName: string;
  engineMode: EngineMode;
  primaryAgent: string;
  multiAgentConfig: MultiAgentConfig;
  verification: VerificationConfig;
  security: SecurityConfig;
}

export interface ApprovalRequestPayload {
  approvalId: string;
  taskId: string;
  trigger: ApprovalTrigger;
  summary: string;
  affectedFiles: string[];
  timestamp: string;
}

export interface ApprovalDecisionPayload {
  approvalId: string;
  taskId: string;
  approved: boolean;
  userNote?: string;
}

export interface TerminalStreamEvent {
  taskId: string;
  stream: 'stdout' | 'stderr' | 'system';
  data: string;
  attempt: number;
  timestamp: string;
}

export interface IAgentAdapter {
  readonly agentId: string;
  plan(payload: AgentTaskPayload): Promise<AgentResponse>;
  execute(payload: AgentTaskPayload): Promise<AgentResponse>;
  review?(
    payload: AgentTaskPayload,
    proposedDiffs: FileDiff[]
  ): Promise<{
    approved: boolean;
    feedback?: string;
  }>;
}

