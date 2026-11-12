export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  fallbackAgent?: string;
}

export interface CircuitBreakerStatus {
  state: CircuitState;
  consecutiveFailures: number;
  failureThreshold: number;
  resetTimeoutMs: number;
  lastFailureTime?: string;
  lastTripTime?: string;
  totalTrips: number;
  fallbackAgent?: string;
}

export class CircuitBreakerSentinel {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private failureThreshold: number;
  private resetTimeoutMs: number;
  private lastFailureTime?: string;
  private lastTripTime?: string;
  private totalTrips = 0;
  private fallbackAgent?: string;

  constructor(config: CircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? 3;
    this.resetTimeoutMs = config.resetTimeoutMs ?? 30000;
    this.fallbackAgent = config.fallbackAgent;
  }

  public canExecute(): boolean {
    if (this.state === 'CLOSED') {
      return true;
    }

    if (this.state === 'OPEN') {
      if (this.lastTripTime) {
        const elapsed = Date.now() - new Date(this.lastTripTime).getTime();
        if (elapsed >= this.resetTimeoutMs) {
          this.state = 'HALF_OPEN';
          return true;
        }
      }
      return false;
    }

    // HALF_OPEN allows probe execution
    return true;
  }

  public recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'CLOSED';
  }

  public recordFailure(error?: Error | string): void {
    this.consecutiveFailures += 1;
    this.lastFailureTime = new Date().toISOString();

    if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.lastTripTime = new Date().toISOString();
      this.totalTrips += 1;
    }
  }

  public tripManually(reason?: string): void {
    this.state = 'OPEN';
    this.lastTripTime = new Date().toISOString();
    this.lastFailureTime = this.lastTripTime;
    this.totalTrips += 1;
  }

  public reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
  }

  public getEffectiveAgent(requestedAgent: string): string {
    if (this.state === 'OPEN' && this.fallbackAgent) {
      return this.fallbackAgent;
    }
    return requestedAgent;
  }

  public setFallbackAgent(agent?: string): void {
    this.fallbackAgent = agent;
  }

  public getStatus(): CircuitBreakerStatus {
    // Check if OPEN cooldown has elapsed
    if (this.state === 'OPEN' && this.lastTripTime) {
      const elapsed = Date.now() - new Date(this.lastTripTime).getTime();
      if (elapsed >= this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
      }
    }

    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      failureThreshold: this.failureThreshold,
      resetTimeoutMs: this.resetTimeoutMs,
      lastFailureTime: this.lastFailureTime,
      lastTripTime: this.lastTripTime,
      totalTrips: this.totalTrips,
      fallbackAgent: this.fallbackAgent,
    };
  }
}
