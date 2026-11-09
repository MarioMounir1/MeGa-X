import * as path from 'path';
import { loadMegaXConfig } from './config/configLoader';

export * from './types/contracts';
export * from './config/configLoader';
export * from './patcher/filePatcher';
export * from './security/securityGate';
export * from './git/gitManager';
export * from './verifier/verificationRunner';

export function bootstrapDaemon(configPath?: string): void {
  const defaultPath = path.resolve(__dirname, '..', '..', 'megax.config.json');
  const config = loadMegaXConfig(configPath ?? defaultPath);

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
}

if (require.main === module) {
  bootstrapDaemon();
}
