import { GitManager } from './gitManager';

export interface ReleaseNotesOptions {
  version?: string;
  limit?: number;
  title?: string;
}

export interface CategorizedCommits {
  features: string[];
  fixes: string[];
  maintenance: string[];
  tests: string[];
  other: string[];
}

export class ReleaseNotesGenerator {
  constructor(private readonly git: GitManager) {}

  public categorizeCommits(limit = 50): CategorizedCommits {
    const commits = this.git.getRecentCommits(limit);
    const result: CategorizedCommits = {
      features: [],
      fixes: [],
      maintenance: [],
      tests: [],
      other: [],
    };

    for (const commit of commits) {
      const subject = commit.subject.trim();
      const lower = subject.toLowerCase();

      if (lower.startsWith('feat') || lower.includes('add ')) {
        result.features.push(`- ${subject} (\`${commit.hash}\`)`);
      } else if (lower.startsWith('fix') || lower.includes('heal') || lower.includes('bug')) {
        result.fixes.push(`- ${subject} (\`${commit.hash}\`)`);
      } else if (lower.startsWith('test') || lower.includes('suite')) {
        result.tests.push(`- ${subject} (\`${commit.hash}\`)`);
      } else if (lower.startsWith('chore') || lower.startsWith('refactor') || lower.startsWith('docs')) {
        result.maintenance.push(`- ${subject} (\`${commit.hash}\`)`);
      } else {
        result.other.push(`- ${subject} (\`${commit.hash}\`)`);
      }
    }

    return result;
  }

  public generateMarkdown(options: ReleaseNotesOptions = {}): string {
    const version = options.version ?? 'v1.0.0';
    const title = options.title ?? `Release Notes for MeGa X ${version}`;
    const limit = options.limit ?? 50;
    const cat = this.categorizeCommits(limit);

    const sections: string[] = [
      `# ${title}`,
      `*Generated on ${new Date().toISOString().split('T')[0]}*\n`,
    ];

    if (cat.features.length > 0) {
      sections.push('### 🚀 Features & Subsystems', ...cat.features, '');
    }
    if (cat.fixes.length > 0) {
      sections.push('### 🐛 Bug Fixes & Resilience', ...cat.fixes, '');
    }
    if (cat.tests.length > 0) {
      sections.push('### 🧪 Testing & Verification', ...cat.tests, '');
    }
    if (cat.maintenance.length > 0) {
      sections.push('### 🛠️ Maintenance & Refactoring', ...cat.maintenance, '');
    }
    if (cat.other.length > 0) {
      sections.push('### 📋 Other Changes', ...cat.other, '');
    }

    return sections.join('\n').trim() + '\n';
  }
}
