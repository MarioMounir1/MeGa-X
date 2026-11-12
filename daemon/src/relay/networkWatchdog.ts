import * as os from 'os';
import { DiscoveredEndpoint, TunnelInspector } from './tunnelInspector';

export type NetworkConnectivityStatus = 'ONLINE' | 'DEGRADED' | 'OFFLINE';

export interface NetworkTransitionEvent {
  type:
    | 'INITIAL_STATE'
    | 'PRIMARY_ENDPOINT_CHANGED'
    | 'TAILSCALE_CONNECTED'
    | 'TAILSCALE_DISCONNECTED'
    | 'CONNECTIVITY_DEGRADED'
    | 'CONNECTIVITY_RESTORED';
  previousPrimary?: string;
  currentPrimary: string;
  timestamp: string;
}

export interface NetworkHealthSnapshot {
  status: NetworkConnectivityStatus;
  primaryEndpoint: string;
  tailscaleConnected: boolean;
  lanConnected: boolean;
  activeEndpoints: DiscoveredEndpoint[];
  lastCheckedAt: string;
  transitionHistory: NetworkTransitionEvent[];
}

export type NetworkTransitionListener = (event: NetworkTransitionEvent) => void;

/**
 * Cross-Platform Network Interface & Tailscale Health Monitor and Watchdog.
 */
export class NetworkHealthMonitor {
  private readonly port: number;
  private readonly checkIntervalMs: number;
  private readonly listener?: NetworkTransitionListener;
  private readonly interfacesProvider: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  private timer?: NodeJS.Timeout;
  private lastSnapshot?: NetworkHealthSnapshot;
  private readonly transitionHistory: NetworkTransitionEvent[] = [];
  private readonly maxHistorySize: number;

  constructor(
    port = 4040,
    options?: {
      checkIntervalMs?: number;
      listener?: NetworkTransitionListener;
      interfacesProvider?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
      maxHistorySize?: number;
    }
  ) {
    this.port = port;
    this.checkIntervalMs = options?.checkIntervalMs ?? 0;
    this.listener = options?.listener;
    this.interfacesProvider = options?.interfacesProvider ?? (() => os.networkInterfaces());
    this.maxHistorySize = options?.maxHistorySize ?? 50;

    // Run initial baseline check
    this.checkNow();
  }

  /**
   * Forces an immediate check of network interfaces and evaluates transitions.
   */
  public checkNow(customInterfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): NetworkHealthSnapshot {
    const interfacesMap = customInterfaces ?? this.interfacesProvider();
    const endpoints = TunnelInspector.discoverEndpoints(this.port, interfacesMap);

    const tailscaleEp = endpoints.find((e) => e.networkType === 'TAILSCALE');
    const lanEp = endpoints.find((e) => e.networkType === 'LAN');
    const tailscaleConnected = Boolean(tailscaleEp);
    const lanConnected = Boolean(lanEp);

    let status: NetworkConnectivityStatus = 'OFFLINE';
    let primary = `ws://127.0.0.1:${this.port}/ws`;

    if (tailscaleConnected) {
      status = 'ONLINE';
      primary = tailscaleEp!.wsUrl;
    } else if (lanConnected) {
      status = 'ONLINE';
      primary = lanEp!.wsUrl;
    } else if (endpoints.length > 0) {
      status = 'DEGRADED';
      primary = endpoints[0].wsUrl;
    } else {
      status = 'DEGRADED';
    }

    const now = new Date().toISOString();

    // Check for transitions compared to lastSnapshot
    if (!this.lastSnapshot) {
      this.recordTransition({
        type: 'INITIAL_STATE',
        currentPrimary: primary,
        timestamp: now,
      });
    } else {
      const prev = this.lastSnapshot;
      if (prev.primaryEndpoint !== primary) {
        this.recordTransition({
          type: 'PRIMARY_ENDPOINT_CHANGED',
          previousPrimary: prev.primaryEndpoint,
          currentPrimary: primary,
          timestamp: now,
        });
      }

      if (!prev.tailscaleConnected && tailscaleConnected) {
        this.recordTransition({
          type: 'TAILSCALE_CONNECTED',
          previousPrimary: prev.primaryEndpoint,
          currentPrimary: primary,
          timestamp: now,
        });
      } else if (prev.tailscaleConnected && !tailscaleConnected) {
        this.recordTransition({
          type: 'TAILSCALE_DISCONNECTED',
          previousPrimary: prev.primaryEndpoint,
          currentPrimary: primary,
          timestamp: now,
        });
      }

      if (prev.status === 'ONLINE' && status === 'DEGRADED') {
        this.recordTransition({
          type: 'CONNECTIVITY_DEGRADED',
          previousPrimary: prev.primaryEndpoint,
          currentPrimary: primary,
          timestamp: now,
        });
      } else if (prev.status === 'DEGRADED' && status === 'ONLINE') {
        this.recordTransition({
          type: 'CONNECTIVITY_RESTORED',
          previousPrimary: prev.primaryEndpoint,
          currentPrimary: primary,
          timestamp: now,
        });
      }
    }

    const snapshot: NetworkHealthSnapshot = {
      status,
      primaryEndpoint: primary,
      tailscaleConnected,
      lanConnected,
      activeEndpoints: endpoints,
      lastCheckedAt: now,
      transitionHistory: [...this.transitionHistory],
    };

    this.lastSnapshot = snapshot;
    return snapshot;
  }

  private recordTransition(evt: NetworkTransitionEvent): void {
    this.transitionHistory.push(evt);
    if (this.transitionHistory.length > this.maxHistorySize) {
      this.transitionHistory.shift();
    }
    if (this.listener) {
      try {
        this.listener(evt);
      } catch {
        // Safe dispatch
      }
    }
  }

  public getSnapshot(): NetworkHealthSnapshot {
    return this.lastSnapshot ?? this.checkNow();
  }

  public start(): void {
    if (this.checkIntervalMs > 0 && !this.timer) {
      this.timer = setInterval(() => {
        this.checkNow();
      }, this.checkIntervalMs);
    }
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
