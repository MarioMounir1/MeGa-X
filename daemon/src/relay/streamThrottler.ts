import { TerminalStreamEvent } from '../types/contracts';

export interface StreamThrottlerOptions {
  /**
   * Time window in milliseconds to coalesce rapid consecutive chunks of the same stream.
   * Set to 0 for immediate synchronous delivery.
   */
  flushIntervalMs?: number;
  /**
   * Maximum characters per emitted TerminalStreamEvent chunk to prevent mobile UI frame drops.
   */
  maxChunkLength?: number;
  /**
   * Maximum number of recent TerminalStreamEvents retained in the scrollback ring buffer.
   */
  maxBufferEvents?: number;
}

/**
 * Coalesces, chunks, and buffers high-frequency child-process stdout/stderr streams
 * so the Flutter Mobile Controller UI remains responsive and receives scrollback on reconnect.
 */
export class TerminalStreamThrottler {
  private readonly flushIntervalMs: number;
  private readonly maxChunkLength: number;
  private readonly maxBufferEvents: number;
  private readonly onFlush: (event: TerminalStreamEvent) => void;
  private readonly ringBuffer: TerminalStreamEvent[] = [];

  private pendingEvent: TerminalStreamEvent | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    onFlush: (event: TerminalStreamEvent) => void,
    options: StreamThrottlerOptions = {}
  ) {
    this.onFlush = onFlush;
    this.flushIntervalMs = options.flushIntervalMs ?? 0;
    this.maxChunkLength = options.maxChunkLength ?? 4096;
    this.maxBufferEvents = options.maxBufferEvents ?? 200;
  }

  /**
   * Pushes a raw TerminalStreamEvent into the throttler.
   */
  public push(event: TerminalStreamEvent): void {
    if (this.flushIntervalMs <= 0) {
      this.emitChunked(event);
      return;
    }

    if (
      this.pendingEvent &&
      this.pendingEvent.taskId === event.taskId &&
      this.pendingEvent.stream === event.stream &&
      this.pendingEvent.attempt === event.attempt
    ) {
      this.pendingEvent = {
        ...this.pendingEvent,
        data: this.pendingEvent.data + event.data,
        timestamp: event.timestamp,
      };
      return;
    }

    // Different stream type or task -> flush previous immediately
    this.flushNow();
    this.pendingEvent = { ...event };
    this.flushTimer = setTimeout(() => {
      this.flushNow();
    }, this.flushIntervalMs);
  }

  /**
   * Immediately flushes any pending coalesced terminal chunk.
   */
  public flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.pendingEvent) {
      return;
    }
    const toEmit = this.pendingEvent;
    this.pendingEvent = null;
    this.emitChunked(toEmit);
  }

  private emitChunked(event: TerminalStreamEvent): void {
    const text = event.data;
    if (text.length <= this.maxChunkLength) {
      this.recordAndEmit(event);
      return;
    }

    for (let i = 0; i < text.length; i += this.maxChunkLength) {
      const slice = text.slice(i, i + this.maxChunkLength);
      this.recordAndEmit({
        ...event,
        data: slice,
      });
    }
  }

  private recordAndEmit(event: TerminalStreamEvent): void {
    this.ringBuffer.push(event);
    if (this.ringBuffer.length > this.maxBufferEvents) {
      this.ringBuffer.shift();
    }
    this.onFlush(event);
  }

  /**
   * Returns a snapshot of the bounded scrollback ring buffer.
   */
  public getRecentLogs(): TerminalStreamEvent[] {
    return [...this.ringBuffer];
  }

  public clearBuffer(): void {
    this.ringBuffer.length = 0;
  }
}

