/** One exact TCP destination that a workspace grants to new sandboxes. */
export interface PrivateRoute {
  host: string;
  port: number;
}

export type PrivateConnectorStatus =
  | 'needs_login'
  | 'awaiting_approval'
  | 'connecting'
  | 'connected'
  | 'unavailable';

/** The customer tailnet connector that YAS owns for one Talyn workspace. */
export interface PrivateConnector {
  id: string;
  workspaceId: string;
  createdAt: string;
  routes: PrivateRoute[];
  status?: PrivateConnectorStatus;
  /** Present only once, in the response that starts interactive login. */
  loginUrl?: string;
  loginExpiresAt?: string;
}

/** One device on the connected tailnet, as the connector sees it. */
export interface PrivatePeer {
  /** Short host name. */
  name: string;
  /** MagicDNS name without the trailing dot. Empty when the tailnet has no MagicDNS. */
  dnsName: string;
  /** Tailnet IP addresses, IPv4 first. */
  addresses: string[];
  os: string;
  online: boolean;
  /** Approved subnet routes that the peer advertises, without exit-node routes. */
  subnetRoutes: string[];
}

export interface PrivatePeersResponse {
  peers: PrivatePeer[];
}

export interface ReplacePrivateRoutesInput {
  routes: PrivateRoute[];
}

/** Clients use this only to decide whether to draw the settings surface. */
export function privateRoutesOffered(
  features: { privateRoutes?: boolean } | null | undefined,
): boolean {
  return features?.privateRoutes === true;
}
