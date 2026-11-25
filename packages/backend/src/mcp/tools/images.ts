import type { SandboxImage } from '../../services/workbenches/sandboxImage.js';
import { callApi } from '../api.js';
import { defineTool, requireId, str } from './helpers.js';
import type { McpCallContext, McpToolResult } from './index.js';

/** A session's own token shows images from its own box only. A user's token names the session. */
function targetSession(args: Record<string, unknown>, ctx: McpCallContext | undefined): string {
  const self = ctx?.session?.workbenchId;
  const sessionId = str(args.session_id) ?? self;
  if (!sessionId) throw new Error('session_id is required');
  if (self && sessionId !== self) throw new Error('A session can show images from its own sandbox only.');
  return sessionId;
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const IMAGES = [
  defineTool(
    'show_image',
    "Show an image file from this session's sandbox to the person. Talyn shows the image in the transcript. Use it for each screenshot that you make for the person or for a pull request. The file must be a PNG, JPEG, GIF or WebP image of 3.5 MB or less. The image also goes into your context.",
    {
      path: { type: 'string', description: 'The image file. Absolute, or relative to the repository.' },
      session_id: {
        type: 'string',
        description: 'The session. Default: the calling session. A session token can only use its own session.',
      },
    },
    ['path'],
    { readOnlyHint: true },
    async (ownerId, args, ctx): Promise<McpToolResult> => {
      const sessionId = targetSession(args, ctx);
      const params = new URLSearchParams({ path: requireId(args, 'path'), live: '1' });
      const image = await callApi<SandboxImage>(
        ownerId,
        'GET',
        `/workbenches/${encodeURIComponent(sessionId)}/image?${params}`
      );
      return {
        content: [
          { type: 'text', text: `Showing ${image.path} (${sizeText(image.bytes)})` },
          { type: 'image', data: image.data, mimeType: image.mediaType },
        ],
      };
    }
  ),
];
