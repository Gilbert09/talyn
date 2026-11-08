import type { AdminRunEventPage, WorkbenchAttachment, WorkbenchImportResult } from '@talyn/shared';
import { createSseJsonParser } from '@talyn/shared';
import * as core from './native.js';
import { request, rawRequest } from './http.js';
import { configureApiClient as configure, type ApiClientConfig } from './config.js';
import { browserLifecycle } from './browserLifecycle.js';

export * from './native.js';
export { ReviewRankingArchive } from './reviewRankingArchive.js';
export { ReviewRankingUploader, type RankingUploadEvent } from './reviewRankingUpload.js';

/** Keep browser lifecycle events on the existing package entry. */
export function configureApiClient(next: ApiClientConfig): void {
  configure({
    ...next,
    runtime: { ...next.runtime, lifecycle: next.runtime?.lifecycle ?? browserLifecycle },
  });
}

const enc = encodeURIComponent;

export const workbenches = {
  ...core.workbenches,
  uploadAttachment: (workbenchId: string, file: Blob, name: string): Promise<WorkbenchAttachment> =>
    request<WorkbenchAttachment>(
      'POST',
      `/workbenches/${enc(workbenchId)}/attachments`,
      undefined,
      false,
      { body: file, contentType: file.type, name }
    ),
  /**
   * Continue a local Claude Code conversation in a fresh sandbox session. The
   * body is the framed upload `claudeSessionImport.ts` describes.
   */
  import: (workbenchId: string, body: Uint8Array | Blob): Promise<WorkbenchImportResult> =>
    request<WorkbenchImportResult>(
      'POST',
      `/workbenches/${enc(workbenchId)}/import`,
      undefined,
      false,
      {
        body: new Blob([body as BlobPart], { type: 'application/octet-stream' }),
        contentType: 'application/octet-stream',
      }
    ),

  attachmentBlob: async (id: string, path: string): Promise<Blob> =>
    (await rawRequest('GET', `/workbenches/${enc(id)}/attachments/raw?path=${enc(path)}`)).blob(),
};

export const admin = {
  ...core.admin,
  fleet: {
    ...core.admin.fleet,
    /**
     * Follow a run's transcript live.
     *
     * `fetch` + ReadableStream, NOT `EventSource`. EventSource cannot set an
     * Authorization header, and the alternative — putting the JWT in the query
     * string — is the thing the WS auth path already refuses to do, because
     * tokens in URLs land in access logs and the edge proxy's request log.
     *
     * Resolves when the run goes terminal, the stream ends, or `signal` aborts.
     * A broken stream is not fatal: the caller still has the cursor endpoint and
     * can resume from `frame.cursor`.
     */
    async followRun(
      host: string,
      runId: string,
      opts: {
        after?: number;
        signal: AbortSignal;
        onFrame: (frame: AdminRunEventPage) => void;
      }
    ): Promise<void> {
      const resp = await rawRequest(
        'GET',
        `/admin/fleet/hosts/${encodeURIComponent(host)}/runs/${encodeURIComponent(
          runId
        )}/stream${opts.after === undefined ? '' : `?after=${encodeURIComponent(opts.after)}`}`,
        { accept: 'text/event-stream', signal: opts.signal }
      );
      if (!resp.body) return;

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseJsonParser<AdminRunEventPage>();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
            opts.onFrame(frame);
            if (frame.terminal) return;
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
  },
};

export const api = { ...core.api, workbenches, admin };
