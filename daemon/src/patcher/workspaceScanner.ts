import * as fs from 'fs';
import * as path from 'path';
import { ContextFile } from '../types/contracts';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.megax',
  'node_modules',
  'dist',
  'build',
  '.dart_tool',
  'coverage',
]);

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.dart',
  '.py',
  '.sql',
  '.prisma',
  '.md',
]);

export interface ScannerOptions {
  maxFiles?: number;
  maxFileSizeBytes?: number;
}

export interface WorkspaceFileEntry {
  path: string;
  sizeBytes: number;
  extension: string;
  modifiedAt: string;
}

export interface WorkspaceSearchMatch {
  path: string;
  lineNumber: number;
  lineText: string;
}

/**
 * Automatically discovers and ranks relevant source files in the workspace
 * for a high-level mobile prompt so developers don't have to type file paths on mobile.
 */
export class WorkspaceScanner {
  private readonly workspaceRoot: string;
  private readonly maxFiles: number;
  private readonly maxFileSizeBytes: number;

  constructor(workspaceRoot: string, options: ScannerOptions = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.maxFiles = options.maxFiles ?? 8;
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? 64 * 1024;
  }

  /**
   * Recursively lists metadata for candidate source files in the workspace,
   * optionally filtered by a case-insensitive substring query.
   */
  public listWorkspaceFileEntries(query?: string): WorkspaceFileEntry[] {
    const entriesList: WorkspaceFileEntry[] = [];
    const normalizedQuery = query?.trim().toLowerCase();

    const walk = (currentDir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!CODE_EXTENSIONS.has(ext)) {
            continue;
          }
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size <= this.maxFileSizeBytes) {
              const rel = path
                .relative(this.workspaceRoot, fullPath)
                .replace(/\\/g, '/');
              if (
                !normalizedQuery ||
                rel.toLowerCase().includes(normalizedQuery)
              ) {
                entriesList.push({
                  path: rel,
                  sizeBytes: stat.size,
                  extension: ext,
                  modifiedAt: stat.mtime.toISOString(),
                });
              }
            }
          } catch {
            // Ignore unreadable files
          }
        }
      }
    };

    walk(this.workspaceRoot);
    entriesList.sort((a, b) => a.path.localeCompare(b.path));
    return entriesList;
  }

  /**
   * Recursively lists relative paths of candidate source files in the workspace.
   */
  public listCandidateFiles(): string[] {
    return this.listWorkspaceFileEntries().map((entry) => entry.path);
  }

  /**
   * Ranks workspace files against keywords in the user prompt and returns the top matching ContextFiles.
   */
  public discoverContextForPrompt(prompt: string): ContextFile[] {
    const keywords = prompt
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 3);

    const candidates = this.listCandidateFiles();
    const scored: { relPath: string; content: string; score: number }[] = [];

    for (const relPath of candidates) {
      const fullPath = path.join(this.workspaceRoot, relPath);
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }

      const lowerPath = relPath.toLowerCase();
      const lowerContent = content.toLowerCase();
      let score = 0;

      for (const kw of keywords) {
        if (lowerPath.includes(kw)) {
          score += 5;
        }
        if (lowerContent.includes(kw)) {
          score += 1;
        }
      }

      scored.push({ relPath, content, score });
    }

    scored.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));

    return scored.slice(0, this.maxFiles).map((item) => ({
      path: item.relPath,
      content: item.content,
    }));
  }

  /**
   * Searches inside candidate workspace source files for a case-insensitive substring query
   * and returns matching file paths, 1-based line numbers, and line snippets.
   */
  public searchCodeContents(
    query: string,
    maxMatches = 50
  ): WorkspaceSearchMatch[] {
    const cleanQuery = query.trim().toLowerCase();
    if (!cleanQuery) {
      return [];
    }

    const candidates = this.listCandidateFiles();
    const matches: WorkspaceSearchMatch[] = [];

    for (const relPath of candidates) {
      if (matches.length >= maxMatches) {
        break;
      }
      const fullPath = path.join(this.workspaceRoot, relPath);
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(cleanQuery)) {
          matches.push({
            path: relPath,
            lineNumber: i + 1,
            lineText: lines[i].trim().slice(0, 200),
          });
          if (matches.length >= maxMatches) {
            break;
          }
        }
      }
    }

    return matches;
  }
}

