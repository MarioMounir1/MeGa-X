import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export class GitOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitOperationError';
  }
}

export class GitManager {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Executes a git command synchronously inside the workspace root.
   */
  public runGit(args: string[]): string {
    try {
      return execFileSync('git', args, {
        cwd: this.workspaceRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (err: unknown) {
      const stderr =
        err && typeof err === 'object' && 'stderr' in err
          ? String((err as { stderr: unknown }).stderr).trim()
          : err instanceof Error
          ? err.message
          : String(err);
      throw new GitOperationError(
        `git ${args.join(' ')} failed: ${stderr}`
      );
    }
  }

  /**
   * Returns true if the workspace root has its own .git directory and a valid HEAD commit.
   */
  public isGitRepository(): boolean {
    if (!fs.existsSync(path.join(this.workspaceRoot, '.git'))) {
      return false;
    }
    try {
      this.runGit(['rev-parse', '--verify', 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns the current checked-out branch name.
   */
  public getCurrentBranch(): string {
    return this.runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  /**
   * Sanitizes a taskId into a valid branch suffix (`megax/<task-id>`).
   */
  public static formatTaskBranchName(taskId: string): string {
    const cleanId = taskId
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return `megax/${cleanId || 'task'}`;
  }

  /**
   * Creates and checks out an isolated task branch (`megax/task-id`).
   * If the branch already exists, checks it out.
   */
  public createTaskBranch(taskId: string): string {
    const branchName = GitManager.formatTaskBranchName(taskId);
    const existingBranches = this.runGit(['branch', '--list', branchName]);

    if (existingBranches) {
      this.runGit(['checkout', branchName]);
    } else {
      this.runGit(['checkout', '-b', branchName]);
    }
    return branchName;
  }

  /**
   * Stages all modifications/creations/deletions and creates a commit if there are staged changes.
   * Returns the commit short hash, or null if working tree was already clean.
   */
  public commitAll(message: string): string | null {
    this.runGit(['add', '-A']);
    try {
      this.runGit(['reset', '--', '.megax']);
    } catch {
      // Ignore if .megax does not exist
    }
    const status = this.runGit([
      'status',
      '--porcelain',
      '--untracked-files=normal',
    ])
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.includes('.megax'))
      .join('\n');
    if (!status) {
      return null;
    }
    this.runGit(['commit', '-m', message]);
    return this.runGit(['rev-parse', '--short', 'HEAD']);
  }

  /**
   * Executes a hard rollback (`git reset --hard HEAD` and `git clean -fd`) to wipe broken changes.
   * Optionally switches back to `returnBranch` and deletes the failed task branch.
   */
  public hardRollback(options?: {
    returnBranch?: string;
    deleteTaskBranch?: string;
  }): void {
    this.runGit(['reset', '--hard', 'HEAD']);
    this.runGit(['clean', '-fd', '-e', '.megax']);

    if (options?.returnBranch) {
      const current = this.getCurrentBranch();
      if (current !== options.returnBranch) {
        this.runGit(['checkout', options.returnBranch]);
      }
    }

    if (
      options?.deleteTaskBranch &&
      options.deleteTaskBranch !== this.getCurrentBranch()
    ) {
      const exists = this.runGit([
        'branch',
        '--list',
        options.deleteTaskBranch,
      ]);
      if (exists) {
        this.runGit(['branch', '-D', options.deleteTaskBranch]);
      }
    }
  }
}

