#!/usr/bin/env node
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { loadMegaXConfig } from './config/configLoader';
import { getEnvDiagnostics } from './config/envConfig';
import { validateDockerEnvironment } from './container/dockerConfigValidator';
import { BenchmarkRunner } from './benchmark/benchmarkRunner';
import { ReleaseNotesGenerator } from './git/releaseNotes';
import { bootstrapDaemon, getEcosystemHealthReport, startDaemonRelayServer } from './index';
import { TunnelInspector } from './relay/tunnelInspector';
import { EngineMode, MegaXConfig } from './types/contracts';

export const DEFAULT_MEGAX_CONFIG: MegaXConfig = {
  projectName: 'Target-Project',
  engineMode: 'SINGLE_AGENT',
  primaryAgent: 'claude-3-7-sonnet',
  multiAgentConfig: {
    planner: 'claude-3-7-sonnet',
    executor: 'antigravity',
    reviewer: 'codex',
  },
  verification: {
    testCommand: 'npm test',
    compileCommand: 'npx tsc --noEmit',
    maxFixAttempts: 3,
  },
  security: {
    requireApprovalOn: ['DB_MIGRATION', 'FILE_DELETE', 'MAX_RETRY_EXCEEDED'],
  },
};

/**
 * Scaffolds a new `megax.config.json` in the target directory.
 */
export function initMegaXProject(
  targetDir: string,
  projectName?: string
): string {
  const resolvedDir = path.resolve(targetDir);
  if (!fs.existsSync(resolvedDir)) {
    fs.mkdirSync(resolvedDir, { recursive: true });
  }

  const configPath = path.join(resolvedDir, 'megax.config.json');
  const config: MegaXConfig = {
    ...DEFAULT_MEGAX_CONFIG,
    projectName: projectName ?? (path.basename(resolvedDir) || 'Target-Project'),
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return configPath;
}

/**
 * Executes a CLI command array and returns a structured summary.
 */
export async function runMegaXCli(args: string[]): Promise<{
  exitCode: number;
  output: string;
}> {
  const [command, ...rest] = args;

  if (!command || command === 'help' || command === '--help') {
    const helpText = [
      'MeGa X CLI — Universal Multi-Agent AI Orchestrator',
      '',
      'Usage:',
      '  megax init [dir]                  Create a megax.config.json in [dir]',
      '  megax status [--config <path>]    Display project config and audit history',
      '  megax doctor [--config <path>]    Run system readiness & environment check',
      '  megax docker [--root <path>]      Validate Docker container readiness',
      '  megax benchmark [--scenario <id>] Run autonomous self-healing benchmarks',
      '  megax health [--config <path>]    Display full ecosystem subsystem health',
      '  megax notes [--version <v>]       Generate release notes from Git history',
      '  megax budget [--config <path>]    Display AI token usage and cost budget',
      '  megax state [get|set|list|clear]  Manage persistent workspace state entries',
      '  megax verify [--config <path>]    Run compile & test verification suite',
      '  megax diff [--config <path>]      Show uncommitted git diff in workspace',
      '  megax run "<prompt>" [--mode <M>] Run an autonomous self-healing task',
      '  megax serve [--port <number>]     Start Mobile Relay Server & Web UI',
    ].join('\n');
    return { exitCode: 0, output: helpText };
  }

  if (command === 'doctor') {
    const cfgIdx = rest.indexOf('--config');
    const cfgPath =
      cfgIdx !== -1 && rest[cfgIdx + 1]
        ? path.resolve(rest[cfgIdx + 1])
        : path.resolve(__dirname, '..', '..', 'megax.config.json');

    let gitVersion = 'NOT_FOUND';
    try {
      gitVersion = execFileSync('git', ['--version'], {
        encoding: 'utf-8',
      }).trim();
    } catch {
      // Git missing
    }

    const config = loadMegaXConfig(cfgPath);
    const diag = getEnvDiagnostics();
    const pairing = TunnelInspector.getPairingInfo(diag.port);

    const report = [
      '=== MeGa X System Readiness Doctor ===',
      `Node Runtime   : ${process.version}`,
      `Git Binary     : ${gitVersion}`,
      `Config Valid   : YES (${config.projectName} | ${config.engineMode})`,
      `Recommended WS : ${pairing.recommendedWsUrl}`,
      `Providers Ready: Claude=${diag.providersConfigured.anthropicClaude} | Codex=${diag.providersConfigured.openaiCodex} | AntiGravity=${diag.providersConfigured.geminiAntiGravity}`,
    ].join('\n');

    return {
      exitCode: gitVersion === 'NOT_FOUND' ? 1 : 0,
      output: report,
    };
  }

  if (command === 'init') {
    const targetDir = rest[0] ?? process.cwd();
    const createdPath = initMegaXProject(targetDir);
    return {
      exitCode: 0,
      output: `Initialized MeGa X configuration at: ${createdPath}`,
    };
  }

  if (command === 'docker') {
    const rootIdx = rest.indexOf('--root');
    const rootDir =
      rootIdx !== -1 && rest[rootIdx + 1]
        ? path.resolve(rest[rootIdx + 1])
        : path.resolve(__dirname, '..', '..');

    const report = validateDockerEnvironment(rootDir);
    const output = [
      '=== MeGa X Docker Readiness Check ===',
      `Valid         : ${report.valid ? 'YES' : 'NO'}`,
      `Dockerfile    : ${report.dockerfile.exists ? 'FOUND' : 'MISSING'} (MultiStage=${report.dockerfile.isMultiStage}, Git=${report.dockerfile.hasGitInstalled}, Healthcheck=${report.dockerfile.hasCurlHealthcheck}, Port=${report.dockerfile.exposedPort})`,
      `Docker Compose: ${report.compose.exists ? 'FOUND' : 'MISSING'} (DaemonService=${report.compose.hasDaemonService}, PortMapping=${report.compose.hasPortMapping}, WorkspaceVolume=${report.compose.hasWorkspaceVolume}, Healthcheck=${report.compose.hasHealthcheck})`,
      report.errors.length > 0 ? `\nErrors:\n${report.errors.map(e => `  - ${e}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      exitCode: report.valid ? 0 : 1,
      output,
    };
  }

  if (command === 'health') {
    const cfgIdx = rest.indexOf('--config');
    const cfgPath =
      cfgIdx !== -1 && rest[cfgIdx + 1]
        ? path.resolve(rest[cfgIdx + 1])
        : path.resolve(__dirname, '..', '..', 'megax.config.json');

    const engine = bootstrapDaemon(cfgPath);
    const health = getEcosystemHealthReport(engine);

    const lines = [
      '=== MeGa X Ecosystem Health Report ===',
      `Version        : ${health.version}`,
      `Status         : ${health.status}`,
      `Timestamp      : ${health.timestamp}`,
      'Subsystems:',
      `  Daemon Core       : ${health.subsystems.daemonCore ? 'HEALTHY' : 'DEGRADED'}`,
      `  Git Manager       : ${health.subsystems.gitManager ? 'HEALTHY' : 'DEGRADED'}`,
      `  Security Gate     : ${health.subsystems.securityGate ? 'HEALTHY' : 'DEGRADED'}`,
      `  Network Watchdog  : ${health.subsystems.networkWatchdog ? 'HEALTHY' : 'DEGRADED'}`,
      `  Consensus Engine  : ${health.subsystems.consensusEngine ? 'HEALTHY' : 'DEGRADED'}`,
      `  Benchmark Profiler: ${health.subsystems.benchmarkProfiler ? 'HEALTHY' : 'DEGRADED'}`,
      'Metrics:',
      `  Total Test Suites : ${health.metrics.totalTestSuites}`,
      `  Registered Agents : ${health.metrics.registeredAgentCount}`,
    ];

    return {
      exitCode: health.status === 'HEALTHY' ? 0 : 1,
      output: lines.join('\n'),
    };
  }

  if (command === 'notes') {
    const vIdx = rest.indexOf('--version');
    const version = vIdx !== -1 && rest[vIdx + 1] ? rest[vIdx + 1] : 'v1.0.0';
    const lIdx = rest.indexOf('--limit');
    const limit = lIdx !== -1 && rest[lIdx + 1] ? Number(rest[lIdx + 1]) : 50;

    const cfgIdx = rest.indexOf('--config');
    const cfgPath =
      cfgIdx !== -1 && rest[cfgIdx + 1]
        ? path.resolve(rest[cfgIdx + 1])
        : path.resolve(__dirname, '..', '..', 'megax.config.json');

    const engine = bootstrapDaemon(cfgPath);
    const generator = new ReleaseNotesGenerator(engine.getGitManager());
    const notes = generator.generateMarkdown({ version, limit });

    return {
      exitCode: 0,
      output: notes,
    };
  }

  if (command === 'budget') {
    const cfgIdx = rest.indexOf('--config');
    const cfgPath =
      cfgIdx !== -1 && rest[cfgIdx + 1]
        ? path.resolve(rest[cfgIdx + 1])
        : path.resolve(__dirname, '..', '..', 'megax.config.json');

    const engine = bootstrapDaemon(cfgPath);
    const summary = engine.getBudgetManager().getSummary();

    const lines = [
      '=== MeGa X Token & Cost Budget Summary ===',
      `Total Tokens      : ${summary.totalTokens} (Prompt: ${summary.totalPromptTokens}, Completion: ${summary.totalCompletionTokens})`,
      `Estimated Cost    : $${summary.totalEstimatedCostUsd.toFixed(4)}`,
      `Logged Records    : ${summary.recordsCount}`,
      `Budget Exceeded   : ${summary.isBudgetExceeded ? 'YES' : 'NO'}`,
    ];
    if (summary.exceededReason) {
      lines.push(`Reason            : ${summary.exceededReason}`);
    }

    return {
      exitCode: summary.isBudgetExceeded ? 1 : 0,
      output: lines.join('\n'),
    };
  }

  if (command === 'state') {
    const sub = rest[0] || 'list';
    const cfgIdx = rest.indexOf('--config');
    const cfgPath =
      cfgIdx !== -1 && rest[cfgIdx + 1]
        ? path.resolve(rest[cfgIdx + 1])
        : path.resolve(__dirname, '..', '..', 'megax.config.json');

    const engine = bootstrapDaemon(cfgPath);
    const store = engine.getStateStore();

    if (sub === 'get') {
      const key = rest[1];
      if (!key) {
        return { exitCode: 1, output: 'Error: Key required. Usage: megax state get <key>' };
      }
      const val = store.get(key);
      return {
        exitCode: val !== undefined ? 0 : 1,
        output: val !== undefined ? JSON.stringify(val, null, 2) : `Key "${key}" not found.`,
      };
    }

    if (sub === 'set') {
      const key = rest[1];
      const rawVal = rest[2];
      if (!key || rawVal === undefined) {
        return { exitCode: 1, output: 'Error: Key and value required. Usage: megax state set <key> <val>' };
      }
      let val: unknown = rawVal;
      try {
        val = JSON.parse(rawVal);
      } catch {
        // use string as-is
      }
      store.set(key, val);
      return {
        exitCode: 0,
        output: `Set state key "${key}" = ${JSON.stringify(val)}`,
      };
    }

    if (sub === 'clear') {
      store.clear();
      return { exitCode: 0, output: 'Cleared workspace state.' };
    }

    // Default: list
    const all = store.getAll();
    const count = Object.keys(all).length;
    const output = [
      `=== MeGa X Workspace State (${count} entries) ===`,
      count > 0 ? JSON.stringify(all, null, 2) : '  (empty)',
    ].join('\n');
    return { exitCode: 0, output };
  }

  if (command === 'benchmark') {
    const scIdx = rest.indexOf('--scenario');
    const scenarioId = scIdx !== -1 && rest[scIdx + 1] ? rest[scIdx + 1] : undefined;

    const runner = new BenchmarkRunner();
    const report = await runner.runSuite(scenarioId);

    const lines = [
      '=== MeGa X Autonomous Benchmark Report ===',
      `Total Scenarios : ${report.totalScenarios}`,
      `Passed Scenarios: ${report.passedScenarios}/${report.totalScenarios} (${report.passRatePercent}%)`,
      `Stability Score : ${report.stabilityScore}/100`,
      `Average Latency : ${report.avgDurationMs}ms`,
      '',
      'Scenario Breakdown:',
      ...report.results.map(
        (r) =>
          `  - [${r.passed ? 'PASS' : 'FAIL'}] ${r.name} (${r.scenarioId}): outcome=${r.actualOutcome}, attempts=${r.attemptsUsed}, latency=${r.durationMs}ms`
      ),
    ];

    return {
      exitCode: report.passRatePercent === 100 ? 0 : 1,
      output: lines.join('\n'),
    };
  }

  if (command === 'status') {
    const cfgIdx = rest.indexOf('--config');
    const cfgPath =
      cfgIdx !== -1 && rest[cfgIdx + 1]
        ? path.resolve(rest[cfgIdx + 1])
        : path.resolve(__dirname, '..', '..', 'megax.config.json');

    const config = loadMegaXConfig(cfgPath);
    const engine = bootstrapDaemon(cfgPath);
    const history = engine.getAuditStore().readAll();

    const summary = [
      `Project      : ${config.projectName}`,
      `Engine Mode  : ${config.engineMode}`,
      `Primary Agent: ${config.primaryAgent}`,
      `Audit Runs   : ${history.length} recorded run(s)`,
    ].join('\n');

    return { exitCode: 0, output: summary };
  }

  if (command === 'verify') {
    const cfgIdx = rest.indexOf('--config');
    const cfgPath =
      cfgIdx !== -1 && rest[cfgIdx + 1]
        ? path.resolve(rest[cfgIdx + 1])
        : path.resolve(__dirname, '..', '..', 'megax.config.json');

    const engine = bootstrapDaemon(cfgPath);
    const runner = engine.getVerificationRunner();
    const result = await runner.runVerificationSuite(
      `cli_verify_${Date.now() % 10000}`,
      1
    );

    const output = [
      `=== MeGa X Verification Result ===`,
      `Passed       : ${result.passed ? 'YES' : 'NO'}`,
      `Compile Step : ${result.compileResult.passed ? 'PASSED' : 'FAILED'} (${result.compileResult.durationMs}ms)`,
      result.testResult
        ? `Test Step    : ${result.testResult.passed ? 'PASSED' : 'FAILED'} (${result.testResult.durationMs}ms)`
        : 'Test Step    : SKIPPED',
      result.errorLog ? `\nDiagnostics:\n${result.errorLog}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      exitCode: result.passed ? 0 : 1,
      output,
    };
  }

  if (command === 'diff') {
    const cfgIdx = rest.indexOf('--config');
    const cfgPath =
      cfgIdx !== -1 && rest[cfgIdx + 1]
        ? path.resolve(rest[cfgIdx + 1])
        : path.resolve(__dirname, '..', '..', 'megax.config.json');

    const engine = bootstrapDaemon(cfgPath);
    const git = engine.getGitManager();
    const diff = git.getWorkingTreeDiff();

    const output = [
      `Branch  : ${diff.currentBranch}`,
      `Status  : ${diff.statusLines.length === 0 ? 'Clean' : diff.statusLines.join(', ')}`,
      diff.unifiedDiff ? `\nDiff:\n${diff.unifiedDiff}` : '\nNo uncommitted changes.',
    ].join('\n');

    return {
      exitCode: 0,
      output,
    };
  }

  if (command === 'run') {
    const prompt = rest[0];
    if (!prompt) {
      return {
        exitCode: 1,
        output: 'Error: Missing prompt. Usage: megax run "<prompt>"',
      };
    }

    const cfgIdx = rest.indexOf('--config');
    const cfgPath =
      cfgIdx !== -1 && rest[cfgIdx + 1]
        ? path.resolve(rest[cfgIdx + 1])
        : path.resolve(__dirname, '..', '..', 'megax.config.json');

    const engine = bootstrapDaemon(cfgPath);

    const modeIdx = rest.indexOf('--mode');
    if (modeIdx !== -1 && rest[modeIdx + 1]) {
      engine.setEngineMode(rest[modeIdx + 1] as EngineMode);
    }

    const taskId = `cli_${Date.now() % 100000}`;
    const result = await engine.runFeaturePrompt(taskId, prompt);
    return {
      exitCode: result.overallSuccess ? 0 : 1,
      output: `Task ${result.masterTaskId} finished (${
        result.overallSuccess ? 'SUCCESS' : 'FAILED'
      }) in ${result.engineMode} mode.`,
    };
  }

  if (command === 'serve') {
    const portIdx = rest.indexOf('--port');
    const port =
      portIdx !== -1 && rest[portIdx + 1] ? Number(rest[portIdx + 1]) : 4040;
    const { port: boundPort } = await startDaemonRelayServer(port);
    return {
      exitCode: 0,
      output: `MeGa X Relay Server listening on port ${boundPort}`,
    };
  }

  return {
    exitCode: 1,
    output: `Unknown command: "${command}". Run "megax --help" for usage.`,
  };
}

if (require.main === module) {
  void runMegaXCli(process.argv.slice(2)).then(({ exitCode, output }) => {
    console.log(output);
    if (process.argv[2] !== 'serve') {
      process.exit(exitCode);
    }
  });
}

