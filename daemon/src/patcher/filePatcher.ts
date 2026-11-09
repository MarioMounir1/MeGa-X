import * as fs from 'fs';
import * as path from 'path';
import { ContextFile, FileDiff } from '../types/contracts';

export class PatchSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchSecurityError';
  }
}

export class FilePatcher {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  /**
   * Resolves a relative file path against the workspace root and prevents path traversal.
   */
  public resolveSafePath(relativePath: string): string {
    const normalized = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
    const resolved = path.resolve(this.workspaceRoot, normalized);

    const relativeToRoot = path.relative(this.workspaceRoot, resolved);
    if (
      relativeToRoot.startsWith('..') ||
      path.isAbsolute(relativeToRoot)
    ) {
      throw new PatchSecurityError(
        `Path traversal blocked: "${relativePath}" resolves outside workspace root.`
      );
    }

    // Double-check original path didn't explicitly attempt '..' traversal out of root
    const directResolved = path.resolve(this.workspaceRoot, relativePath);
    const directRelative = path.relative(this.workspaceRoot, directResolved);
    if (directRelative.startsWith('..') || path.isAbsolute(directRelative)) {
      throw new PatchSecurityError(
        `Path traversal blocked: "${relativePath}" resolves outside workspace root.`
      );
    }

    return directResolved;
  }

  /**
   * Applies an array of FileDiff operations (CREATE, UPDATE, DELETE) to the workspace.
   */
  public applyDiffs(fileDiffs: FileDiff[]): string[] {
    const modifiedPaths: string[] = [];

    for (const diff of fileDiffs) {
      const targetPath = this.resolveSafePath(diff.path);

      switch (diff.action) {
        case 'CREATE':
        case 'UPDATE': {
          const parentDir = path.dirname(targetPath);
          if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
          }
          fs.writeFileSync(targetPath, diff.content, 'utf-8');
          modifiedPaths.push(diff.path);
          break;
        }
        case 'DELETE': {
          if (fs.existsSync(targetPath)) {
            fs.unlinkSync(targetPath);
            modifiedPaths.push(diff.path);
          }
          break;
        }
        default: {
          const exhaustiveCheck: never = diff.action;
          throw new Error(`Unsupported FileDiff action: ${String(exhaustiveCheck)}`);
        }
      }
    }

    return modifiedPaths;
  }

  /**
   * Reads existing workspace files into ContextFile[] for AgentTaskPayload.
   */
  public readContextFiles(relativePaths: string[]): ContextFile[] {
    const contextFiles: ContextFile[] = [];

    for (const relPath of relativePaths) {
      const fullPath = this.resolveSafePath(relPath);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        contextFiles.push({
          path: relPath,
          content: fs.readFileSync(fullPath, 'utf-8'),
        });
      }
    }

    return contextFiles;
  }
}

