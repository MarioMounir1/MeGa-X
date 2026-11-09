import * as crypto from 'crypto';
import {
  ApprovalDecisionPayload,
  ApprovalRequestPayload,
  ApprovalTrigger,
  FileDiff,
  SecurityConfig,
} from '../types/contracts';

export type ApprovalHandler = (
  request: ApprovalRequestPayload
) => Promise<ApprovalDecisionPayload>;

const DB_MIGRATION_PATH_PATTERNS = [
  /migrations?\//i,
  /prisma\/schema\.prisma$/i,
  /\.sql$/i,
  /knexfile/i,
  /typeorm/i,
  /drizzle/i,
];

const DB_MIGRATION_CONTENT_PATTERNS = [
  /\b(CREATE|ALTER|DROP|TRUNCATE)\s+TABLE\b/i,
  /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i,
  /\bqueryRunner\.(createTable|dropTable|addColumn|dropColumn|query)\b/i,
];

export class SecurityGate {
  private readonly requiredTriggers: Set<ApprovalTrigger>;
  private approvalHandler?: ApprovalHandler;

  constructor(
    securityConfig: SecurityConfig,
    approvalHandler?: ApprovalHandler
  ) {
    this.requiredTriggers = new Set(securityConfig.requireApprovalOn);
    this.approvalHandler = approvalHandler;
  }

  public setApprovalHandler(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }

  public isTriggerEnabled(trigger: ApprovalTrigger): boolean {
    return this.requiredTriggers.has(trigger);
  }

  /**
   * Inspects proposed FileDiff[] and returns all matching ApprovalTriggers configured in megax.config.json.
   */
  public detectDiffTriggers(fileDiffs: FileDiff[]): {
    trigger: ApprovalTrigger;
    affectedFiles: string[];
    summary: string;
  }[] {
    const detected: {
      trigger: ApprovalTrigger;
      affectedFiles: string[];
      summary: string;
    }[] = [];

    // 1. Check FILE_DELETE
    if (this.isTriggerEnabled('FILE_DELETE')) {
      const deletedFiles = fileDiffs
        .filter((d) => d.action === 'DELETE')
        .map((d) => d.path);

      if (deletedFiles.length > 0) {
        detected.push({
          trigger: 'FILE_DELETE',
          affectedFiles: deletedFiles,
          summary: `Task requests deletion of ${deletedFiles.length} file(s): ${deletedFiles.join(', ')}`,
        });
      }
    }

    // 2. Check DB_MIGRATION
    if (this.isTriggerEnabled('DB_MIGRATION')) {
      const migrationFiles = fileDiffs
        .filter((d) => {
          const pathMatch = DB_MIGRATION_PATH_PATTERNS.some((regex) =>
            regex.test(d.path.replace(/\\/g, '/'))
          );
          const contentMatch =
            d.action !== 'DELETE' &&
            DB_MIGRATION_CONTENT_PATTERNS.some((regex) =>
              regex.test(d.content)
            );
          return pathMatch || contentMatch;
        })
        .map((d) => d.path);

      if (migrationFiles.length > 0) {
        detected.push({
          trigger: 'DB_MIGRATION',
          affectedFiles: migrationFiles,
          summary: `Task modifies database schema or migration file(s): ${migrationFiles.join(', ')}`,
        });
      }
    }

    return detected;
  }

  /**
   * Requests human-in-the-loop approval for a specific trigger.
   * If no approval handler is registered, rejects by default for safety.
   */
  public async requestApproval(
    taskId: string,
    trigger: ApprovalTrigger,
    summary: string,
    affectedFiles: string[]
  ): Promise<ApprovalDecisionPayload> {
    const request: ApprovalRequestPayload = {
      approvalId: `apr_${crypto.randomUUID().slice(0, 8)}`,
      taskId,
      trigger,
      summary,
      affectedFiles,
      timestamp: new Date().toISOString(),
    };

    if (!this.approvalHandler) {
      return {
        approvalId: request.approvalId,
        taskId,
        approved: false,
        userNote: `Denied automatically: No mobile approval handler registered for ${trigger}.`,
      };
    }

    return this.approvalHandler(request);
  }

  /**
   * Evaluates a set of FileDiffs against configured security gates and awaits approval if triggered.
   */
  public async verifyDiffsOrWait(
    taskId: string,
    fileDiffs: FileDiff[]
  ): Promise<{ approved: boolean; rejectedBy?: ApprovalTrigger; note?: string }> {
    const triggers = this.detectDiffTriggers(fileDiffs);

    for (const item of triggers) {
      const decision = await this.requestApproval(
        taskId,
        item.trigger,
        item.summary,
        item.affectedFiles
      );
      if (!decision.approved) {
        return {
          approved: false,
          rejectedBy: item.trigger,
          note: decision.userNote,
        };
      }
    }

    return { approved: true };
  }
}

