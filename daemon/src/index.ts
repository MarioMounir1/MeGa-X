import * as path from 'path';
import { loadMegaXConfig } from './config/configLoader';
import { OrchestratorEngine } from './orchestrator/orchestratorEngine';
import { MobileRelayServer } from './relay/mobileRelayServer';

export * from './types/contracts';
export * from './config/configLoader';
export * from './patcher/filePatcher';
export * from './security/securityGate';
export * from './git/gitManager';
export * from './verifier/verificationRunner';
export * from './agents/agentRegistry';
export * from './orchestrator/orchestratorEngine';
export * from './relay/mobileRelayServer';

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
  });
}

export async function startDaemonRelayServer(
  port = 4040,
  configPath?: string
): Promise<{ engine: OrchestratorEngine; relay: MobileRelayServer; port: number }> {
  const engine = bootstrapDaemon(configPath);
  const relay = new MobileRelayServer(engine);
  const boundPort = await relay.start(port, '0.0.0.0');
  console.log(`📡 Mobile Relay Server listening on ws://0.0.0.0:${boundPort}/ws`);
  return { engine, relay, port: boundPort };
}

if (require.main === module) {
  bootstrapDaemon();
}
