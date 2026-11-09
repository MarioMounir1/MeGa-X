import * as fs from 'fs';
import * as path from 'path';
import {
  ApprovalTrigger,
  EngineMode,
  MegaXConfig,
} from '../types/contracts';

const VALID_ENGINE_MODES: EngineMode[] = ['SINGLE_AGENT', 'MULTI_AGENT'];
const VALID_APPROVAL_TRIGGERS: ApprovalTrigger[] = [
  'DB_MIGRATION',
  'FILE_DELETE',
  'MAX_RETRY_EXCEEDED',
];

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(`Invalid megax.config.json: ${message}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Validates an untrusted object against the MegaXConfig contract.
 */
export function validateMegaXConfig(raw: unknown): MegaXConfig {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigValidationError('Root configuration must be a JSON object.');
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.projectName !== 'string' || obj.projectName.trim() === '') {
    throw new ConfigValidationError('"projectName" must be a non-empty string.');
  }

  if (
    typeof obj.engineMode !== 'string' ||
    !VALID_ENGINE_MODES.includes(obj.engineMode as EngineMode)
  ) {
    throw new ConfigValidationError(
      `"engineMode" must be one of: ${VALID_ENGINE_MODES.join(', ')}.`
    );
  }

  if (typeof obj.primaryAgent !== 'string' || obj.primaryAgent.trim() === '') {
    throw new ConfigValidationError('"primaryAgent" must be a non-empty string.');
  }

  // Validate multiAgentConfig
  if (!obj.multiAgentConfig || typeof obj.multiAgentConfig !== 'object') {
    throw new ConfigValidationError('"multiAgentConfig" must be an object.');
  }
  const ma = obj.multiAgentConfig as Record<string, unknown>;
  for (const role of ['planner', 'executor', 'reviewer'] as const) {
    if (typeof ma[role] !== 'string' || (ma[role] as string).trim() === '') {
      throw new ConfigValidationError(
        `"multiAgentConfig.${role}" must be a non-empty string.`
      );
    }
  }

  // Validate verification
  if (!obj.verification || typeof obj.verification !== 'object') {
    throw new ConfigValidationError('"verification" must be an object.');
  }
  const ver = obj.verification as Record<string, unknown>;
  if (typeof ver.testCommand !== 'string' || ver.testCommand.trim() === '') {
    throw new ConfigValidationError(
      '"verification.testCommand" must be a non-empty string.'
    );
  }
  if (
    typeof ver.compileCommand !== 'string' ||
    ver.compileCommand.trim() === ''
  ) {
    throw new ConfigValidationError(
      '"verification.compileCommand" must be a non-empty string.'
    );
  }
  if (
    typeof ver.maxFixAttempts !== 'number' ||
    !Number.isInteger(ver.maxFixAttempts) ||
    ver.maxFixAttempts < 1
  ) {
    throw new ConfigValidationError(
      '"verification.maxFixAttempts" must be a positive integer.'
    );
  }

  // Validate security
  if (!obj.security || typeof obj.security !== 'object') {
    throw new ConfigValidationError('"security" must be an object.');
  }
  const sec = obj.security as Record<string, unknown>;
  if (!Array.isArray(sec.requireApprovalOn)) {
    throw new ConfigValidationError(
      '"security.requireApprovalOn" must be an array.'
    );
  }
  for (const trigger of sec.requireApprovalOn) {
    if (
      typeof trigger !== 'string' ||
      !VALID_APPROVAL_TRIGGERS.includes(trigger as ApprovalTrigger)
    ) {
      throw new ConfigValidationError(
        `Invalid security trigger "${String(
          trigger
        )}". Allowed values: ${VALID_APPROVAL_TRIGGERS.join(', ')}.`
      );
    }
  }

  return {
    projectName: obj.projectName,
    engineMode: obj.engineMode as EngineMode,
    primaryAgent: obj.primaryAgent,
    multiAgentConfig: {
      planner: ma.planner as string,
      executor: ma.executor as string,
      reviewer: ma.reviewer as string,
    },
    verification: {
      testCommand: ver.testCommand,
      compileCommand: ver.compileCommand,
      maxFixAttempts: ver.maxFixAttempts,
    },
    security: {
      requireApprovalOn: sec.requireApprovalOn as ApprovalTrigger[],
    },
  };
}

/**
 * Loads and validates `megax.config.json` from the given file path or workspace root.
 */
export function loadMegaXConfig(configPath?: string): MegaXConfig {
  const resolvedPath =
    configPath ?? path.resolve(process.cwd(), '..', 'megax.config.json');

  if (!fs.existsSync(resolvedPath)) {
    throw new ConfigValidationError(`Configuration file not found at: ${resolvedPath}`);
  }

  const rawText = fs.readFileSync(resolvedPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigValidationError(`Failed to parse JSON: ${message}`);
  }

  return validateMegaXConfig(parsed);
}

