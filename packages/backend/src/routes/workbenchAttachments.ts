import express, { Router, type Request, type Response } from 'express';
import { v4 as uuid } from 'uuid';
import { shellQuote, type ApiResponse, type WorkbenchAttachment } from '@talyn/shared';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import { userMayUseWorkbenches, workbenchesRefusalReason } from '../services/workbenches/access.js';
import { fleetErrorAsRefusal, notReadyError, WorkbenchError } from '../services/workbenches/errors.js';
import { recordWorkbenchEvent, repoDirFor, runCapture } from '../services/workbenches/sandboxRuntime.js';
import { writeSandboxFiles } from '../services/workbenches/sandboxFiles.js';
import { getWorkbench } from '../services/workbenches/store.js';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function matchesImage(type: string, data: Buffer): boolean {
  if (type === 'image/png') return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/jpeg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (type === 'image/gif') return data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a';
  if (type === 'image/webp') return data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

export function workbenchAttachmentRoutes(): Router {
  const router = Router();
  router.post('/:id/attachments', express.raw({ type: IMAGE_TYPES, limit: '10mb' }), async (req: Request, res: Response) => {
    const bad = (status: number, error: string, code?: string) =>
      res.status(status).json({ success: false, error, ...(code ? { code } : {}) });
    const row = await getWorkbench(req.params.id);
    if (!row) return bad(404, 'Session not found');
    try {
      await requireWorkspaceAccess(req, row.workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const user = assertUser(req);
    if (!(await userMayUseWorkbenches({ distinctId: user.id, email: user.email }))) {
      return bad(403, `Sessions are not available: ${workbenchesRefusalReason()}.`, 'workbenches_unavailable');
    }
    try {
      if (row.runtime === 'local') throw new WorkbenchError('This session runs on your machine.', 400, 'local_runtime');
      if (row.archivedAt) throw notReadyError('archived');
      if (row.status !== 'ready' || !row.sandboxId) throw notReadyError(row.status);

      const mimeType = req.headers['content-type']?.split(';', 1)[0]?.toLowerCase() ?? '';
      if (!IMAGE_TYPES.includes(mimeType)) return bad(415, 'Unsupported image type.');
      const data = req.body;
      if (!Buffer.isBuffer(data) || data.length === 0) return bad(400, 'The image is empty.');
      if (!matchesImage(mimeType, data)) return bad(415, 'Image bytes do not match the declared type.');

      let requestedName: string;
      try {
        requestedName = decodeURIComponent(req.get('X-Attachment-Name') || 'image');
      } catch {
        return bad(400, 'Invalid attachment name.');
      }
      const name = Array.from(requestedName)
        .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
        .join('')
        .slice(0, 200) || 'image';
      const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 80) || 'image';
      const path = `.context/attachments/${uuid()}-${safe}`;
      const exclude = `exclude=$(git rev-parse --git-path info/exclude)\nmkdir -p "$(dirname "$exclude")"\ntouch "$exclude"\ngrep -qxF ${shellQuote('.context/')} "$exclude" || printf '%s\\n' ${shellQuote('.context/')} >> "$exclude"`;
      const prepared = await runCapture(row, `set -e\n${exclude}`, { quiet: true });
      if (prepared.exitCode !== 0) throw new Error('Could not exclude session attachments from git.');
      await writeSandboxFiles(row, [{ path: `${repoDirFor(row)}/${path}`, base64: data.toString('base64') }], { timeoutMs: 120_000 });
      const attachment: WorkbenchAttachment = { name, mimeType, path };
      recordWorkbenchEvent(row, 'attachment_uploaded', path);
      return res.json({ success: true, data: attachment } as ApiResponse<WorkbenchAttachment>);
    } catch (err) {
      if (err instanceof WorkbenchError) return bad(err.status, err.message, err.code);
      const refusal = fleetErrorAsRefusal(err);
      if (refusal) return bad(refusal.status, refusal.message, refusal.code);
      // Express 4 does not catch a rejected handler, so a throw here would hang the request.
      console.error(`[workbench] attachment upload for ${row.id} failed:`, err);
      return bad(500, 'Could not save the image in the sandbox.');
    }
  });
  return router;
}
