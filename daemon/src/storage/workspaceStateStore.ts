import * as fs from 'fs';
import * as path from 'path';

export class WorkspaceStateStore {
  private readonly stateFilePath: string;

  constructor(workspaceRoot: string) {
    const megaxDir = path.join(workspaceRoot, '.megax');
    if (!fs.existsSync(megaxDir)) {
      fs.mkdirSync(megaxDir, { recursive: true });
    }
    this.stateFilePath = path.join(megaxDir, 'state.json');
  }

  private readState(): Record<string, unknown> {
    try {
      if (!fs.existsSync(this.stateFilePath)) {
        return {};
      }
      const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private writeState(state: Record<string, unknown>): void {
    const tmpPath = `${this.stateFilePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, this.stateFilePath);
  }

  public get<T = unknown>(key: string, defaultValue?: T): T | undefined {
    const state = this.readState();
    if (Object.prototype.hasOwnProperty.call(state, key)) {
      return state[key] as T;
    }
    return defaultValue;
  }

  public set(key: string, value: unknown): void {
    const state = this.readState();
    state[key] = value;
    this.writeState(state);
  }

  public setMultiple(entries: Record<string, unknown>): void {
    const state = this.readState();
    Object.assign(state, entries);
    this.writeState(state);
  }

  public has(key: string): boolean {
    const state = this.readState();
    return Object.prototype.hasOwnProperty.call(state, key);
  }

  public delete(key: string): boolean {
    const state = this.readState();
    if (Object.prototype.hasOwnProperty.call(state, key)) {
      delete state[key];
      this.writeState(state);
      return true;
    }
    return false;
  }

  public getAll(): Record<string, unknown> {
    return this.readState();
  }

  public clear(): void {
    this.writeState({});
  }
}

