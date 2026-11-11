import * as fs from 'fs';
import * as path from 'path';

export interface DockerValidationReport {
  valid: boolean;
  dockerfile: {
    exists: boolean;
    isMultiStage: boolean;
    hasGitInstalled: boolean;
    hasCurlHealthcheck: boolean;
    exposedPort: number | null;
  };
  compose: {
    exists: boolean;
    hasDaemonService: boolean;
    hasPortMapping: boolean;
    hasWorkspaceVolume: boolean;
    hasHealthcheck: boolean;
  };
  errors: string[];
}

/**
 * Validates Dockerfile and docker-compose.yml files for production container readiness.
 */
export function validateDockerEnvironment(rootDir?: string): DockerValidationReport {
  const baseDir = path.resolve(rootDir ?? process.cwd());
  const dockerfilePath = path.join(baseDir, 'Dockerfile');
  const composePath = path.join(baseDir, 'docker-compose.yml');

  const errors: string[] = [];

  const dfReport = {
    exists: fs.existsSync(dockerfilePath),
    isMultiStage: false,
    hasGitInstalled: false,
    hasCurlHealthcheck: false,
    exposedPort: null as number | null,
  };

  if (!dfReport.exists) {
    errors.push(`Dockerfile not found at ${dockerfilePath}`);
  } else {
    const content = fs.readFileSync(dockerfilePath, 'utf-8');
    dfReport.isMultiStage = /FROM\s+\S+\s+AS\s+builder/i.test(content) && /FROM\s+\S+\s+AS\s+runner/i.test(content);
    dfReport.hasGitInstalled = /apk\s+add.*git/is.test(content) || /apt-get.*git/is.test(content);
    dfReport.hasCurlHealthcheck = /HEALTHCHECK.*curl.*\/api\/status/is.test(content);

    const portMatch = content.match(/EXPOSE\s+(\d+)/i);
    if (portMatch) {
      dfReport.exposedPort = parseInt(portMatch[1], 10);
    }

    if (!dfReport.isMultiStage) {
      errors.push('Dockerfile must implement multi-stage build (AS builder & AS runner)');
    }
    if (!dfReport.hasGitInstalled) {
      errors.push('Dockerfile must install git for workspace VCS operations');
    }
    if (!dfReport.hasCurlHealthcheck) {
      errors.push('Dockerfile must define HEALTHCHECK querying /api/status');
    }
    if (dfReport.exposedPort !== 4040) {
      errors.push(`Dockerfile must expose port 4040 (found ${dfReport.exposedPort ?? 'none'})`);
    }
  }

  const composeReport = {
    exists: fs.existsSync(composePath),
    hasDaemonService: false,
    hasPortMapping: false,
    hasWorkspaceVolume: false,
    hasHealthcheck: false,
  };

  if (!composeReport.exists) {
    errors.push(`docker-compose.yml not found at ${composePath}`);
  } else {
    const composeContent = fs.readFileSync(composePath, 'utf-8');
    composeReport.hasDaemonService = /megax-daemon:/i.test(composeContent);
    composeReport.hasPortMapping = /4040:4040/i.test(composeContent) || /:\s*["']?[^"'\n]*:4040["']?/i.test(composeContent);
    composeReport.hasWorkspaceVolume = /:\/workspace/i.test(composeContent);
    composeReport.hasHealthcheck = /healthcheck:/i.test(composeContent) && /\/api\/status/is.test(composeContent);

    if (!composeReport.hasDaemonService) {
      errors.push('docker-compose.yml must define megax-daemon service');
    }
    if (!composeReport.hasPortMapping) {
      errors.push('docker-compose.yml must expose port 4040');
    }
    if (!composeReport.hasWorkspaceVolume) {
      errors.push('docker-compose.yml must mount /workspace directory');
    }
    if (!composeReport.hasHealthcheck) {
      errors.push('docker-compose.yml must configure healthcheck querying /api/status');
    }
  }

  return {
    valid: errors.length === 0,
    dockerfile: dfReport,
    compose: composeReport,
    errors,
  };
}
