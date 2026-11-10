#!/usr/bin/env node
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { loadMegaXConfig } from './config/configLoader';
import { getEnvDiagnostics } from './config/envConfig';
import { bootstrapDaemon, startDaemonRelayServer } from './index';
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

