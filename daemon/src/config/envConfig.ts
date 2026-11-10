export interface EnvDiagnostics {
  port: number;
  providersConfigured: {
    anthropicClaude: boolean;
    openaiCodex: boolean;
    geminiAntiGravity: boolean;
  };
  relaySecurity: {
    tokenAuthEnabled: boolean;
    fcmWebhookConfigured: boolean;
    fcmTarget: string;
  };
}

/**
 * Inspects environment variables and returns a safely redacted diagnostic summary
 * (never exposing raw API keys or tokens) for the Mobile Controller.
 */
export function getEnvDiagnostics(
  env: NodeJS.ProcessEnv = process.env
): EnvDiagnostics {
  const rawPort = Number(env.MEGAX_PORT);
  const port = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 4040;

  return {
    port,
    providersConfigured: {
      anthropicClaude: Boolean(env.ANTHROPIC_API_KEY?.trim()),
      openaiCodex: Boolean(env.OPENAI_API_KEY?.trim()),
      geminiAntiGravity: Boolean(env.GEMINI_API_KEY?.trim()),
    },
    relaySecurity: {
      tokenAuthEnabled: Boolean(env.MEGAX_RELAY_TOKEN?.trim()),
      fcmWebhookConfigured: Boolean(env.MEGAX_FCM_WEBHOOK_URL?.trim()),
      fcmTarget: env.MEGAX_FCM_TARGET?.trim() || 'megax-mobile-controller',
    },
  };
}

