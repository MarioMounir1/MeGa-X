import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Phase 62: Full-Stack Multi-Matrix CI/CD Pipeline & Workflow Validator', () => {
  it('validates GitHub Actions CI workflow structure and multi-platform coverage', () => {
    const ciWorkflowPath = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      '.github',
      'workflows',
      'ci.yml'
    );

    assert.ok(
      fs.existsSync(ciWorkflowPath),
      'Expected .github/workflows/ci.yml to exist'
    );

    const content = fs.readFileSync(ciWorkflowPath, 'utf-8');

    // Job definitions
    assert.ok(
      content.includes('daemon-test-matrix:'),
      'Workflow must define daemon-test-matrix job'
    );
    assert.ok(
      content.includes('mobile-ci:'),
      'Workflow must define mobile-ci job'
    );

    // Matrix configuration
    assert.ok(
      content.includes("'20'") && content.includes("'22'"),
      'Daemon matrix must test Node.js 20 and 22'
    );

    // Pipeline verification steps
    assert.ok(content.includes('npm run typecheck'));
    assert.ok(content.includes('npm run build'));
    assert.ok(content.includes('npm test'));
    assert.ok(content.includes('npx megax health'));
    assert.ok(content.includes('npx megax docker'));

    // Flutter steps
    assert.ok(content.includes('flutter pub get'));
    assert.ok(content.includes('flutter analyze'));
    assert.ok(content.includes('flutter test'));
  });
});

