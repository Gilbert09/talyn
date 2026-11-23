import type { Request } from 'express';
import { publicApiOrigin } from '../mobileReturn.js';
import { INBOUND_PATH } from './receiver.js';

/**
 * The origin a webhook URL starts with. `TALYN_PUBLIC_API_URL` (or the origin
 * of the backend's own OAuth callbacks) when the deployment states it, else
 * the origin the caller used. The caller's origin is wrong only behind a
 * proxy that rewrites the host, and for the MCP tools, which call the API
 * over loopback, so production should set `TALYN_PUBLIC_API_URL`.
 */
export function inboundOrigin(req: Request): string {
  return publicApiOrigin() ?? `${req.protocol}://${req.get('host') ?? 'localhost'}`;
}

/** The URL up to the token, for display. */
export function webhookUrlPrefix(req: Request, connectionId: string): string {
  return `${inboundOrigin(req)}${INBOUND_PATH}/${connectionId}/`;
}

/** The full URL, token included. Built only when the token was just minted. */
export function webhookUrl(req: Request, connectionId: string, token: string): string {
  return `${webhookUrlPrefix(req, connectionId)}${token}`;
}
