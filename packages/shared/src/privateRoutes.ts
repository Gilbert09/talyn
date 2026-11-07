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

export interface ReplacePrivateRoutesInput {
  routes: PrivateRoute[];
}

/** Clients use this only to decide whether to draw the settings surface. */
export function privateRoutesOffered(
  features: { privateRoutes?: boolean } | null | undefined,
): boolean {
  return features?.privateRoutes === true;
}
