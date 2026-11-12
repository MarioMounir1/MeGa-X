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
   * Checks out an existing local branch by name.
   */
  public checkoutBranch(branchName: string): string {
    this.runGit(['checkout', branchName.trim()]);
    return this.getCurrentBranch();
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

  /**
   * Merges a verified `megax/<task-id>` branch into `targetBranch` (e.g. `main`)
   * and optionally deletes the temporary task branch after a clean merge.
   */
  public mergeTaskBranch(
    taskBranch: string,
    targetBranch = 'main',
    deleteAfterMerge = true
  ): string {
    const current = this.getCurrentBranch();
    if (current !== targetBranch) {
      this.runGit(['checkout', targetBranch]);
    }

    this.runGit([
      'merge',
      '--no-ff',
      '-m',
      `Merge verified MeGa X branch ${taskBranch} into ${targetBranch}`,
      taskBranch,
    ]);

    const mergeCommitHash = this.runGit(['rev-parse', '--short', 'HEAD']);

    if (deleteAfterMerge && taskBranch !== targetBranch) {
      this.runGit(['branch', '-d', taskBranch]);
    }

    return mergeCommitHash;
  }

  /**
   * Returns the current working tree status lines and unified diff against HEAD.
   */
  public getWorkingTreeDiff(): {
    currentBranch: string;
    statusLines: string[];
    unifiedDiff: string;
  } {
    if (!this.isGitRepository()) {
      return {
        currentBranch: 'no-git',
        statusLines: [],
        unifiedDiff: '',
      };
    }

    const currentBranch = this.getCurrentBranch();
    const rawStatus = this.runGit([
      'status',
      '--porcelain',
      '--untracked-files=normal',
    ]);
    const statusLines = rawStatus
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.includes('.megax'));

    const unifiedDiff = this.runGit(['diff', 'HEAD']);
    return {
      currentBranch,
      statusLines,
      unifiedDiff,
    };
  }

  /**
   * Returns the unified diff between a base branch and a task branch (`megax/<task-id>`).
   */
  public getBranchDiff(taskBranch: string, baseBranch = 'main'): string {
    return this.runGit(['diff', `${baseBranch}...${taskBranch}`]);
  }

  /**
   * Lists all local `megax/*` task branches in the repository.
   */
  public listTaskBranches(): string[] {
    if (!this.isGitRepository()) {
      return [];
    }
    const raw = this.runGit(['branch', '--list', 'megax/*']);
    return raw
      .split('\n')
      .map((line) => line.replace(/^\*?\s+/, '').trim())
      .filter(Boolean);
  }

  /**
   * Safely deletes an isolated `megax/*` task branch.
   * Refuses to delete non-`megax/` branches (e.g., `main` or `master`).
   * If currently checked out on `taskBranch`, switches to `fallbackBranch` first.
   */
  public deleteTaskBranch(
    taskBranch: string,
    fallbackBranch = 'main'
  ): { deletedBranch: string; currentBranch: string } {
    const cleanBranch = taskBranch.trim();
    if (!cleanBranch.startsWith('megax/')) {
      throw new GitOperationError(
        `Refusing to delete protected non-task branch "${cleanBranch}". Only "megax/*" branches can be deleted.`
      );
    }

    const current = this.getCurrentBranch();
    if (current === cleanBranch) {
      this.runGit(['checkout', fallbackBranch]);
    }

    this.runGit(['branch', '-D', cleanBranch]);
    return {
      deletedBranch: cleanBranch,
      currentBranch: this.getCurrentBranch(),
    };
  }

  /**
   * Squashes all intermediate retry/fix commits on a `megax/*` task branch into a single atomic commit.
   */
  public squashTaskBranchCommits(
    taskBranch: string,
    baseBranch = 'main',
    commitMessage?: string
  ): { taskBranch: string; squashedCommitHash: string } {
    const cleanBranch = taskBranch.trim();
    if (!cleanBranch.startsWith('megax/')) {
      throw new GitOperationError(
        `Refusing to squash non-task branch "${cleanBranch}". Only "megax/*" branches can be squashed.`
      );
    }

    const origBranch = this.getCurrentBranch();
    this.runGit(['checkout', cleanBranch]);

    try {
      const mergeBase = this.runGit(['merge-base', baseBranch, cleanBranch]).trim();
      const headHash = this.runGit(['rev-parse', 'HEAD']).trim();

      if (mergeBase === headHash) {
        throw new GitOperationError(
          `Branch "${cleanBranch}" has no commits ahead of base branch "${baseBranch}".`
        );
      }

      this.runGit(['reset', '--soft', mergeBase]);
      const msg = commitMessage?.trim() || `feat(${cleanBranch}): verified implementation`;
      this.runGit(['commit', '-m', msg]);
      const squashedCommitHash = this.runGit(['rev-parse', '--short', 'HEAD']).trim();

      return {
        taskBranch: cleanBranch,
        squashedCommitHash,
      };
    } finally {
      if (origBranch !== cleanBranch) {
        this.runGit(['checkout', origBranch]);
      }
    }
  }

  /**
   * Stashes any uncommitted manual edits (excluding `.megax`) before switching to a task branch.
   * Returns true if a stash entry was created.
   */
  public stashUncommittedChanges(label = 'megax-preflight'): boolean {
    if (!this.isGitRepository()) {
      return false;
    }
    const { statusLines } = this.getWorkingTreeDiff();
    if (statusLines.length === 0) {
      return false;
    }
    this.runGit([
      'stash',
      'push',
      '--include-untracked',
      '-m',
      label,
      '--',
      ':!.megax',
    ]);
    return true;
  }

  /**
   * Restores the most recent Git stash entry onto the working tree.
   */
  public popLastStash(): void {
    this.runGit(['stash', 'pop']);
  }

  /**
   * Lists all saved Git stash entries in the repository.
   */
  public listStashes(): {
    ref: string;
    message: string;
    date: string;
  }[] {
    if (!this.isGitRepository()) {
      return [];
    }
    const raw = this.runGit(['stash', 'list', '--pretty=format:%gd|%gs|%cI']);
    if (!raw) {
      return [];
    }
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [ref = '', message = '', date = ''] = line.split('|');
        return { ref, message, date };
      });
  }

  /**
   * Returns the most recent commits on the current branch.
   */
  public getRecentCommits(limit = 10): {
    hash: string;
    subject: string;
    author: string;
    date: string;
  }[] {
    if (!this.isGitRepository()) {
      return [];
    }
    const raw = this.runGit([
      'log',
      `-n`,
      String(limit),
      '--pretty=format:%h|%s|%an|%cI',
    ]);
    if (!raw) {
      return [];
    }
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [hash = '', subject = '', author = '', date = ''] =
          line.split('|');
        return { hash, subject, author, date };
      });
  }
}

