import {
  OrchestrationRunResult,
  OrchestratorEngine,
} from './orchestratorEngine';

export interface QueuedTaskItem {
  taskId: string;
  prompt: string;
  contextFiles: string[];
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  enqueuedAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: OrchestrationRunResult;
}

/**
 * Serializes incoming mobile feature prompts into a strict FIFO queue
 * so concurrent mobile dispatches never collide on Git branches in the working tree.
 */
export class TaskQueueManager {
  private readonly engine: OrchestratorEngine;
  private readonly queue: QueuedTaskItem[] = [];
  private isProcessing = false;
  private readonly onResultCallbacks: ((result: OrchestrationRunResult) => void)[] =
    [];

  constructor(
    engine: OrchestratorEngine,
    onTaskCompleted?: (result: OrchestrationRunResult) => void
  ) {
    this.engine = engine;
    if (onTaskCompleted) {
      this.onResultCallbacks.push(onTaskCompleted);
    }
  }

  public onTaskComplete(
    callback: (result: OrchestrationRunResult) => void
  ): void {
    this.onResultCallbacks.push(callback);
  }

  /**
   * Enqueues a prompt for sequential execution and returns a Promise that resolves
   * when this specific task finishes.
   */
  public enqueue(
    taskId: string,
    prompt: string,
    contextFiles: string[] = []
  ): Promise<OrchestrationRunResult> {
    const item: QueuedTaskItem = {
      taskId,
      prompt,
      contextFiles,
      status: 'QUEUED',
      enqueuedAt: new Date().toISOString(),
    };
    this.queue.push(item);

    return new Promise<OrchestrationRunResult>((resolve, reject) => {
      const checkAndRun = async (): Promise<void> => {
        if (this.isProcessing) {
          return;
        }
        this.isProcessing = true;

        try {
          while (true) {
            const next = this.queue.find((q) => q.status === 'QUEUED');
            if (!next) {
              break;
            }

            next.status = 'RUNNING';
            next.startedAt = new Date().toISOString();

            const res = await this.engine.runFeaturePrompt(
              next.taskId,
              next.prompt,
              next.contextFiles
            );

            next.status = res.overallSuccess ? 'COMPLETED' : 'FAILED';
            next.completedAt = new Date().toISOString();
            next.result = res;

            for (const cb of this.onResultCallbacks) {
              cb(res);
            }

            if (next.taskId === taskId) {
              resolve(res);
            }
          }
        } catch (err) {
          reject(err);
        } finally {
          this.isProcessing = false;
        }
      };

      // Also attach a listener in case another loop is already processing our item
      const completionWatcher = (res: OrchestrationRunResult): void => {
        if (res.masterTaskId === taskId) {
          resolve(res);
        }
      };
      this.onResultCallbacks.push(completionWatcher);

      void checkAndRun();
    });
  }

  /**
   * Returns a snapshot of all queued, running, and completed tasks in the session.
   */
  public getQueueSnapshot(): QueuedTaskItem[] {
    return this.queue.map((item) => ({ ...item }));
  }
}

