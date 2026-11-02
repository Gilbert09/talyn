import { Router } from 'express';
import type { ApiResponse, ApiToken, CreateApiTokenRequest, CreateApiTokenResponse } from '@talyn/shared';
import { assertUser } from '../middleware/auth.js';
import {
  ApiTokenInputError,
  createApiToken,
  listApiTokens,
  parseCreateApiTokenInput,
  revokeApiToken,
} from '../services/apiTokens.js';
import { publicApiRefusalReason, userMayUsePublicApi } from '../services/public/access.js';

/**
 * Personal access tokens for the public API, managed by the signed-in user
 * (Settings → Developer). The tokens authenticate `/v1`, which is mounted
 * separately and never accepts a Supabase JWT.
 *
 * Mounted PRE-`ownerScope`: `api_tokens` is a backend-pool-only table (no RLS
 * policy), so every query here passes `req.user.id` itself.
 *
 * Only minting is gated on the `publicApi` flag. Listing and revoking always
 * work, so a person can take a token away whatever the flag says.
 */
export function apiTokenRoutes(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const tokens = await listApiTokens(assertUser(req).id);
    res.json({ success: true, data: tokens } as ApiResponse<ApiToken[]>);
  });

  router.post('/', async (req, res) => {
    const user = assertUser(req);
    if (!(await userMayUsePublicApi({ distinctId: user.id, email: user.email }))) {
      res.status(403).json({
        success: false,
        error: `The Talyn API is not available: ${publicApiRefusalReason()}.`,
        code: 'public_api_unavailable',
      });
      return;
    }
    try {
      const input = parseCreateApiTokenInput(req.body as Partial<CreateApiTokenRequest>);
      const result = await createApiToken(user.id, input, { ip: req.ip ?? null });
      res.status(201).json({ success: true, data: result } as ApiResponse<CreateApiTokenResponse>);
    } catch (err) {
      if (err instanceof ApiTokenInputError) {
        res.status(400).json({ success: false, error: err.message, code: 'invalid_token_request' });
        return;
      }
      throw err;
    }
  });

  router.delete('/:id', async (req, res) => {
    const ok = await revokeApiToken(assertUser(req).id, req.params.id);
    if (!ok) {
      res.status(404).json({ success: false, error: 'Token not found' });
      return;
    }
    res.json({ success: true } as ApiResponse<void>);
  });

  return router;
}
