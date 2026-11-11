import * as os from 'os';

export interface DiscoveredEndpoint {
  interfaceName: string;
  address: string;
  networkType: 'TAILSCALE' | 'LAN' | 'LOOPBACK';
  wsUrl: string;
  httpUrl: string;
}

export interface MobilePairingInfo {
  hostname: string;
  port: number;
  requiresToken: boolean;
  recommendedWsUrl: string;
  androidEmulatorWsUrl: string;
  endpoints: DiscoveredEndpoint[];
}

/**
 * Inspects host network interfaces to automatically detect Tailscale VPN (`100.64.0.0/10`)
 * and LAN Wi-Fi/Ethernet IPv4 endpoints for effortless Mobile Controller pairing.
 */
export class TunnelInspector {
  /**
   * Classifies an IPv4 address and interface name as TAILSCALE, LAN, or LOOPBACK.
   */
  public static classifyIpv4(
    interfaceName: string,
    ip: string
  ): 'TAILSCALE' | 'LAN' | 'LOOPBACK' {
    if (ip.startsWith('127.')) {
      return 'LOOPBACK';
    }

    if (/tailscale/i.test(interfaceName)) {
      return 'TAILSCALE';
    }

    // Tailscale uses the Carrier-Grade NAT (CGNAT) range 100.64.0.0/10 (100.64.0.0 - 100.127.255.255)
    const parts = ip.split('.').map(Number);
    if (
      parts.length === 4 &&
      parts[0] === 100 &&
      parts[1] >= 64 &&
      parts[1] <= 127
    ) {
      return 'TAILSCALE';
    }

    return 'LAN';
  }

  /**
   * Discovers all active IPv4 endpoints on the workstation and builds WebSocket/HTTP URLs.
   */
  public static discoverEndpoints(
    port: number,
    interfacesMap: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
  ): DiscoveredEndpoint[] {
    const endpoints: DiscoveredEndpoint[] = [];

    for (const [ifName, infos] of Object.entries(interfacesMap)) {
      if (!infos) continue;
      for (const info of infos) {
        if (info.family !== 'IPv4' || info.internal) {
          continue;
        }
        const networkType = TunnelInspector.classifyIpv4(ifName, info.address);
        endpoints.push({
          interfaceName: ifName,
          address: info.address,
          networkType,
          wsUrl: `ws://${info.address}:${port}/ws`,
          httpUrl: `http://${info.address}:${port}`,
        });
      }
    }

    // Sort TAILSCALE first, then LAN
    endpoints.sort((a, b) => {
      if (a.networkType === b.networkType) {
        return a.address.localeCompare(b.address);
      }
      return a.networkType === 'TAILSCALE' ? -1 : 1;
    });

    return endpoints;
  }

  /**
   * Generates a URI for QR code scanning on mobile containing connection info and optional token.
   */
  public static generatePairingQrPayload(
    pairingInfo: MobilePairingInfo,
    token?: string
  ): {
    scheme: string;
    targetUrl: string;
    tokenRequired: boolean;
    qrUri: string;
  } {
    const wsUrl = pairingInfo.recommendedWsUrl;
    const tokenPart = token ? `&token=${encodeURIComponent(token)}` : '';
    const qrUri = `megax://connect?url=${encodeURIComponent(wsUrl)}${tokenPart}`;

    return {
      scheme: 'megax',
      targetUrl: wsUrl,
      tokenRequired: pairingInfo.requiresToken,
      qrUri,
    };
  }

  /**
   * Generates a complete pairing manifest for the Flutter Mobile Companion App.
   */
  public static getPairingInfo(
    port: number,
    requiresToken = false,
    interfacesMap?: NodeJS.Dict<os.NetworkInterfaceInfo[]>
  ): MobilePairingInfo {
    const endpoints = TunnelInspector.discoverEndpoints(port, interfacesMap);
    const preferred =
      endpoints.find((e) => e.networkType === 'TAILSCALE') ??
      endpoints.find((e) => e.networkType === 'LAN');

    return {
      hostname: os.hostname(),
      port,
      requiresToken,
      recommendedWsUrl: preferred?.wsUrl ?? `ws://127.0.0.1:${port}/ws`,
      androidEmulatorWsUrl: `ws://10.0.2.2:${port}/ws`,
      endpoints,
    };
  }
}

