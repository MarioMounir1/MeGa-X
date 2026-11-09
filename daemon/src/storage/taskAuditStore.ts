import * as fs from 'fs';
import * as path from 'path';
import { OrchestrationRunResult } from '../orchestrator/orchestratorEngine';

export interface AuditLogEntry extends OrchestrationRunResult {
  prompt: string;
  recordedAt: string;
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
}

