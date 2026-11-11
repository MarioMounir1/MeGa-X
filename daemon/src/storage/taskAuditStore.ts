import * as fs from 'fs';
import * as path from 'path';
import { OrchestrationRunResult } from '../orchestrator/orchestratorEngine';

export interface AuditLogEntry extends OrchestrationRunResult {
  prompt: string;
  recordedAt: string;
}

export interface AuditHistoryQueryOptions {
  status?: 'SUCCESS' | 'FAILED';
  limit?: number;
  taskId?: string;
}

/**
 * Persists task execution history and self-healing outcomes to `.megax/audit-history.json`
 * so mobile users can inspect past runs over `/api/history`.
 */
export class TaskAuditStore {
  private readonly storeFilePath: string;

  constructor(workspaceRoot: string, customFilePath?: string) {
    this.storeFilePath =
      customFilePath ??
      path.join(path.resolve(workspaceRoot), '.megax', 'audit-history.json');
  }

  public getStoreFilePath(): string {
    return this.storeFilePath;
  }

  public readAll(): AuditLogEntry[] {
    if (!fs.existsSync(this.storeFilePath)) {
      return [];
    }
    try {
      const raw = fs.readFileSync(this.storeFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as AuditLogEntry[]) : [];
    } catch {
      return [];
    }
  }

  public recordRun(prompt: string, result: OrchestrationRunResult): AuditLogEntry {
    const dir = path.dirname(this.storeFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const history = this.readAll();
    const entry: AuditLogEntry = {
      ...result,
      prompt,
      recordedAt: new Date().toISOString(),
    };
    history.push(entry);
    fs.writeFileSync(
      this.storeFilePath,
      JSON.stringify(history, null, 2),
      'utf-8'
    );
    return entry;
  }

  /**
   * Queries persisted audit history with optional filtering by taskId, status, and limit.
   */
  public queryHistory(options?: AuditHistoryQueryOptions): AuditLogEntry[] {
    let entries = this.readAll();

    if (options?.taskId) {
      const targetId = options.taskId.trim();
      entries = entries.filter((e) => e.masterTaskId === targetId);
    }

    if (options?.status === 'SUCCESS') {
      entries = entries.filter((e) => e.overallSuccess === true);
    } else if (options?.status === 'FAILED') {
      entries = entries.filter((e) => e.overallSuccess === false);
    }

    if (
      typeof options?.limit === 'number' &&
      !Number.isNaN(options.limit) &&
      options.limit > 0
    ) {
      entries = entries.slice(-options.limit);
    }

    return entries;
  }

  /**
   * Clears all persisted audit history entries and returns the count of cleared entries.
   */
  public clearHistory(): number {
    const existing = this.readAll();
    if (existing.length === 0) {
      return 0;
    }
    const dir = path.dirname(this.storeFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.storeFilePath, JSON.stringify([], null, 2), 'utf-8');
    return existing.length;
  }

  /**
   * Exports the entire audit log as a formatted JSON or Markdown string.
   */
  public exportHistory(format: 'json' | 'markdown' = 'json'): string {
    const history = this.readAll();
    if (format === 'json') {
      return JSON.stringify(history, null, 2);
    }

    const lines: string[] = [
      '# MeGa X Task Audit Execution Report',
      `*Generated at ${new Date().toISOString()} • Total recorded runs: ${history.length}*`,
      '',
      '| Task ID | Engine Mode | Status | Prompt | Recorded At |',
      '| :--- | :--- | :--- | :--- | :--- |',
    ];

    for (const entry of history) {
      const statusIcon = entry.overallSuccess ? '✅ PASSED' : '❌ FAILED';
      const cleanPrompt = entry.prompt.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
      lines.push(
        `| \`${entry.masterTaskId}\` | ${entry.engineMode} | ${statusIcon} | ${cleanPrompt} | ${entry.recordedAt} |`
      );
    }

    return lines.join('\n');
  }
}

