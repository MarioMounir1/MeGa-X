import { ChildProcess, execFileSync, spawn } from 'child_process';
import {
  TerminalStreamEvent,
  VerificationConfig,
} from '../types/contracts';

export type TerminalStreamListener = (event: TerminalStreamEvent) => void;

export interface CommandExecutionResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  passed: boolean;
}

export interface VerificationSuiteResult {
  passed: boolean;
  attempt: number;
  compileResult: CommandExecutionResult;
  testResult?: CommandExecutionResult;
  errorLog?: string; // Formatted stack trace ready for AgentTaskPayload.errorLog
}

export class VerificationRunner {
  private readonly workspaceRoot: string;
  private readonly config: VerificationConfig;
  private streamListener?: TerminalStreamListener;
  private activeChild?: ChildProcess;
  private commandTimeoutMs: number;

  constructor(
    workspaceRoot: string,
    config: VerificationConfig,
    streamListener?: TerminalStreamListener,
    commandTimeoutMs = 120_000
  ) {
    this.workspaceRoot = workspaceRoot;
    this.config = config;
    this.streamListener = streamListener;
    this.commandTimeoutMs = commandTimeoutMs;
  }

  public setCommandTimeoutMs(timeoutMs: number): void {
    this.commandTimeoutMs = timeoutMs;
  }

  public setStreamListener(listener: TerminalStreamListener): void {
    this.streamListener = listener;
  }

  /**
   * Immediately terminates any currently running verification child process (and its process tree).
   */
  public abortActiveProcess(): boolean {
    if (!this.activeChild || this.activeChild.killed) {
      return false;
    }
    try {
      if (process.platform === 'win32' && this.activeChild.pid) {
        execFileSync('taskkill', [
          '/pid',
          String(this.activeChild.pid),
          '/T',
          '/F',
        ], { stdio: 'ignore' });
      } else {
        this.activeChild.kill('SIGTERM');
      }
      return true;
    } catch {
      try {
        this.activeChild.kill();
      } catch {
        // Ignore
      }
      return false;
    }
  }

  private emitStream(
    taskId: string,
    stream: 'stdout' | 'stderr' | 'system',
    data: string,
    attempt: number
  ): void {
    if (!this.streamListener) {
      return;
    }
    this.streamListener({
      taskId,
      stream,
      data,
      attempt,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Executes a single shell command inside workspaceRoot via child_process.spawn,
   * streaming live stdout/stderr chunks and capturing output.
   */
  public runCommand(
    taskId: string,
    command: string,
    attempt: number
  ): Promise<CommandExecutionResult> {
    const startTime = Date.now();
    this.emitStream(
      taskId,
      'system',
      `[Attempt ${attempt}/${this.config.maxFixAttempts}] Running: ${command}\n`,
      attempt
    );

    return new Promise<CommandExecutionResult>((resolve) => {
      const child = spawn(command, {
        cwd: this.workspaceRoot,
        shell: true,
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      this.activeChild = child;

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const watchdog =
        this.commandTimeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              const timeoutMsg = `\n[Watchdog Timeout] Command "${command}" exceeded ${this.commandTimeoutMs}ms limit and was terminated.\n`;
              stderr += timeoutMsg;
              this.emitStream(taskId, 'stderr', timeoutMsg, attempt);
              this.abortActiveProcess();
            }, this.commandTimeoutMs)
          : null;

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        stdout += text;
        this.emitStream(taskId, 'stdout', text, attempt);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        stderr += text;
        this.emitStream(taskId, 'stderr', text, attempt);
      });

      child.on('error', (err: Error) => {
        const errMsg = `Process spawn error: ${err.message}\n`;
        stderr += errMsg;
        this.emitStream(taskId, 'stderr', errMsg, attempt);
        resolve({
          command,
          exitCode: 1,
          stdout,
          stderr,
          durationMs: Date.now() - startTime,
          passed: false,
        });
      });

      child.on('close', (code: number | null) => {
        if (watchdog) {
          clearTimeout(watchdog);
        }
        if (this.activeChild === child) {
          this.activeChild = undefined;
        }
        const exitCode = timedOut ? 124 : code ?? 1;
        const durationMs = Date.now() - startTime;
        const passed = !timedOut && exitCode === 0;

        this.emitStream(
          taskId,
          'system',
          `[Attempt ${attempt}/${this.config.maxFixAttempts}] Command "${command}" exited with code ${exitCode} (${durationMs}ms)\n`,
          attempt
        );

        resolve({
          command,
          exitCode,
          stdout,
          stderr,
          durationMs,
          passed,
        });
      });
    });
  }

  /**
   * Formats a failed CommandExecutionResult into a concise stack-trace log
   * for AgentTaskPayload.errorLog during self-healing retries.
   */
  public static formatErrorLog(
    stage: 'COMPILE_STEP' | 'TEST_STEP',
    result: CommandExecutionResult,
    attempt: number,
    maxAttempts: number
  ): string {
    const combinedOutput = [result.stderr.trim(), result.stdout.trim()]
      .filter(Boolean)
      .join('\n---\n');

    return [
      `=== SELF-HEALING DIAGNOSTIC (${stage} FAILED on Attempt ${attempt}/${maxAttempts}) ===`,
      `Command  : ${result.command}`,
      `Exit Code: ${result.exitCode}`,
      `Output / Stack Trace:`,
      combinedOutput || '(No stdout/stderr output captured)',
    ].join('\n');
  }

  /**
   * Runs the configured compileCommand followed by testCommand.
   * Short-circuits and returns an errorLog if compilation fails.
   */
  public async runVerificationSuite(
    taskId: string,
    attempt = 1
  ): Promise<VerificationSuiteResult> {
    const compileResult = await this.runCommand(
      taskId,
      this.config.compileCommand,
      attempt
    );

    if (!compileResult.passed) {
      return {
        passed: false,
        attempt,
        compileResult,
        errorLog: VerificationRunner.formatErrorLog(
          'COMPILE_STEP',
          compileResult,
          attempt,
          this.config.maxFixAttempts
        ),
      };
    }

    const testResult = await this.runCommand(
      taskId,
      this.config.testCommand,
      attempt
    );

    if (!testResult.passed) {
      return {
        passed: false,
        attempt,
        compileResult,
        testResult,
        errorLog: VerificationRunner.formatErrorLog(
          'TEST_STEP',
          testResult,
          attempt,
          this.config.maxFixAttempts
        ),
      };
    }

    return {
      passed: true,
      attempt,
      compileResult,
      testResult,
    };
  }
}

