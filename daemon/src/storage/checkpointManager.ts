import * as fs from 'fs';
import * as path from 'path';

export interface WorkspaceCheckpoint {
  id: string;
  name: string;
  timestamp: string;
  branch: string;
  fileCount: number;
  files: string[];
  description?: string;
}

export interface CheckpointRestoreResult {
  success: boolean;
  restoredFiles: string[];
  checkpointId: string;
}

export class WorkspaceCheckpointManager {
  private readonly checkpointsDir: string;

  constructor(
    private readonly workspaceRoot: string,
    private readonly getCurrentBranchFn?: () => string
  ) {
    this.checkpointsDir = path.join(this.workspaceRoot, '.megax', 'checkpoints');
    if (!fs.existsSync(this.checkpointsDir)) {
      fs.mkdirSync(this.checkpointsDir, { recursive: true });
    }
  }

  public createCheckpoint(
    name: string,
    options: { files?: string[]; description?: string } = {}
  ): WorkspaceCheckpoint {
    const id = `chk_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const branch = this.getCurrentBranchFn ? this.getCurrentBranchFn() : 'main';
    const targetDir = path.join(this.checkpointsDir, id);
    const filesDir = path.join(targetDir, 'files');

    fs.mkdirSync(filesDir, { recursive: true });

    let filesToSnapshot = options.files ?? [];
    if (filesToSnapshot.length === 0) {
      // Default snapshot candidate: megax.config.json if present
      const defaultCfg = path.join(this.workspaceRoot, 'megax.config.json');
      if (fs.existsSync(defaultCfg)) {
        filesToSnapshot.push('megax.config.json');
      }
    }

    const savedFiles: string[] = [];

    for (const relPath of filesToSnapshot) {
      const srcPath = path.resolve(this.workspaceRoot, relPath);
      if (fs.existsSync(srcPath) && fs.statSync(srcPath).isFile()) {
        const destPath = path.join(filesDir, relPath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
        savedFiles.push(relPath);
      }
    }

    const checkpoint: WorkspaceCheckpoint = {
      id,
      name,
      timestamp: new Date().toISOString(),
      branch,
      fileCount: savedFiles.length,
      files: savedFiles,
      description: options.description,
    };

    fs.writeFileSync(
      path.join(targetDir, 'meta.json'),
      JSON.stringify(checkpoint, null, 2) + '\n',
      'utf-8'
    );

    return checkpoint;
  }

  public listCheckpoints(): WorkspaceCheckpoint[] {
    if (!fs.existsSync(this.checkpointsDir)) {
      return [];
    }

    const entries = fs.readdirSync(this.checkpointsDir, { withFileTypes: true });
    const checkpoints: WorkspaceCheckpoint[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const metaPath = path.join(this.checkpointsDir, entry.name, 'meta.json');
        if (fs.existsSync(metaPath)) {
          try {
            const raw = fs.readFileSync(metaPath, 'utf-8');
            checkpoints.push(JSON.parse(raw) as WorkspaceCheckpoint);
          } catch {
            // Ignore corrupted metadata
          }
        }
      }
    }

    // Sort descending by timestamp
    return checkpoints.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }

  public getCheckpoint(id: string): WorkspaceCheckpoint | null {
    const metaPath = path.join(this.checkpointsDir, id, 'meta.json');
    if (!fs.existsSync(metaPath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(metaPath, 'utf-8');
      return JSON.parse(raw) as WorkspaceCheckpoint;
    } catch {
      return null;
    }
  }

  public restoreCheckpoint(id: string): CheckpointRestoreResult {
    const chk = this.getCheckpoint(id);
    if (!chk) {
      throw new Error(`Checkpoint "${id}" not found.`);
    }

    const filesDir = path.join(this.checkpointsDir, id, 'files');
    const restoredFiles: string[] = [];

    for (const relPath of chk.files) {
      const snapshotPath = path.join(filesDir, relPath);
      if (fs.existsSync(snapshotPath)) {
        const destPath = path.resolve(this.workspaceRoot, relPath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(snapshotPath, destPath);
        restoredFiles.push(relPath);
      }
    }

    return {
      success: true,
      restoredFiles,
      checkpointId: id,
    };
  }

  public deleteCheckpoint(id: string): boolean {
    const targetDir = path.join(this.checkpointsDir, id);
    if (!fs.existsSync(targetDir)) {
      return false;
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
    return true;
  }
}

