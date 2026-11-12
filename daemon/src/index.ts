import * as path from 'path';
import { loadMegaXConfig } from './config/configLoader';
import { OrchestratorEngine } from './orchestrator/orchestratorEngine';
import { FcmDispatcher } from './relay/fcmDispatcher';
import { MobileRelayServer } from './relay/mobileRelayServer';
import { MegaXConfig } from './types/contracts';
import {
  AntiGravityAgentAdapter,
  ClaudeAgentAdapter,
  CodexAgentAdapter,
} from './agents/liveProviders';
import { AgentRegistry } from './agents/agentRegistry';

export * from './types/contracts';
export * from './config/configLoader';
export * from './config/envConfig';
export * from './patcher/filePatcher';
export * from './patcher/workspaceScanner';
export * from './security/securityGate';
export * from './storage/taskAuditStore';
export * from './storage/metricsCollector';
export * from './git/gitManager';
export * from './verifier/verificationRunner';
export * from './agents/agentRegistry';
export * from './agents/liveProviders';
export * from './agents/mockReplayEngine';
export * from './orchestrator/orchestratorEngine';
export * from './orchestrator/consensusEngine';
export * from './orchestrator/taskQueue';
export * from './relay/mobileRelayServer';
export * from './relay/fcmDispatcher';
export * from './relay/streamThrottler';
export * from './relay/tunnelInspector';
export * from './relay/ansiHelper';
export * from './container/dockerConfigValidator';
export * from './benchmark/benchmarkRunner';
export * from './cli';

export function createLiveAgentRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register(new ClaudeAgentAdapter('claude-3-7-sonnet'));
  registry.register(new AntiGravityAgentAdapter('antigravity'));
  registry.register(new CodexAgentAdapter('codex'));
  return registry;
}

export function bootstrapDaemon(configPath?: string): OrchestratorEngine {
  const defaultPath = path.resolve(__dirname, '..', '..', 'megax.config.json');
  const resolvedConfigPath = configPath ?? defaultPath;
  const config = loadMegaXConfig(resolvedConfigPath);
  const workspaceRoot = path.dirname(resolvedConfigPath);

  console.log('==================================================');
  console.log(`🚀 MeGa X Local Core Daemon Initialized`);
  console.log(`📦 Project      : ${config.projectName}`);
  console.log(`⚙️  Engine Mode  : ${config.engineMode}`);
  if (config.engineMode === 'SINGLE_AGENT') {
    console.log(`🤖 Primary Agent: ${config.primaryAgent}`);
  } else {
    console.log(
      `🤖 Multi-Agent  : Planner=${config.multiAgentConfig.planner} | Executor=${config.multiAgentConfig.executor} | Reviewer=${config.multiAgentConfig.reviewer}`
    );
  }
  console.log(
    `🛡️  Security Gate: [${config.security.requireApprovalOn.join(', ')}]`
  );
  console.log(
    `🔄 Self-Healing : Max ${config.verification.maxFixAttempts} attempts (${config.verification.compileCommand} && ${config.verification.testCommand})`
  );
  console.log('==================================================');

  return new OrchestratorEngine({
    workspaceRoot,
    config,
    agentRegistry: createLiveAgentRegistry(),
  });
}

export interface DaemonInstanceSummary {
  version: string;
  projectName: string;
  engineMode: MegaXConfig['engineMode'];
  workspaceRoot: string;
  endpoints: {
    dashboardUrl: string;
    wsUrl: string;
    pairingUrl: string;
  };
}

export function getDaemonInstanceSummary(
  engine: OrchestratorEngine,
  port: number
): DaemonInstanceSummary {
  const cfg = engine.getConfig();
  return {
    version: '1.0.0',
    projectName: cfg.projectName,
    engineMode: cfg.engineMode,
    workspaceRoot: engine.getGitManager().isGitRepository()
      ? path.resolve('.')
      : 'workspace',
    endpoints: {
      dashboardUrl: `http://localhost:${port}/`,
      wsUrl: `ws://localhost:${port}/ws`,
      pairingUrl: `http://localhost:${port}/api/pairing`,
    },
  };
}

export async function startDaemonRelayServer(
  port = 4040,
  configPath?: string
): Promise<{
  engine: OrchestratorEngine;
  relay: MobileRelayServer;
  fcm: FcmDispatcher;
  port: number;
}> {
  const engine = bootstrapDaemon(configPath);
  const fcm = new FcmDispatcher({ logToConsole: true });
  const relay = new MobileRelayServer(engine, fcm.createSender());
  const boundPort = await relay.start(port, '0.0.0.0');
  console.log(
    `📡 Mobile Steering Wheel UI : http://localhost:${boundPort}`
  );
  console.log(
    `📡 WebSocket Relay Endpoint : ws://0.0.0.0:${boundPort}/ws`
  );
  return { engine, relay, fcm, port: boundPort };
}

if (require.main === module) {
  if (process.argv.includes('--serve')) {
    const portArgIndex = process.argv.indexOf('--port');
    const port =
      portArgIndex !== -1 && process.argv[portArgIndex + 1]
        ? Number(process.argv[portArgIndex + 1])
        : 4040;
    void startDaemonRelayServer(port);
  } else {
    bootstrapDaemon();
  }
}
