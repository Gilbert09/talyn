import React, { useEffect, useState } from 'react';
import { FileIcon, Film } from 'lucide-react';
import { isWorkbenchVideoType } from '@talyn/shared';
import { attachmentPreview, loadAttachmentPreview } from '../../lib/attachmentPreviews';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';

type Attachment = { name: string; mimeType: string; path?: string };

export function MessageAttachments({ attachments, ops }: { attachments: Attachment[]; ops: WorkbenchOps }) {
  return (
    <div className="flex flex-wrap gap-2 pt-2">
      {attachments.map((attachment, index) => (
        <MessageAttachment key={`${attachment.path ?? attachment.name}:${index}`} attachment={attachment} ops={ops} />
      ))}
    </div>
  );
}

function MessageAttachment({ attachment, ops }: { attachment: Attachment; ops: WorkbenchOps }) {
  if (isWorkbenchVideoType(attachment.mimeType) && attachment.path) {
    return <VideoAttachment attachment={{ ...attachment, path: attachment.path }} ops={ops} />;
  }
  return <ImageAttachment attachment={attachment} ops={ops} />;
}

/**
 * A video loads only when it is opened. It can be 50 MB, and the transcript
 * must not fetch every video in a chat to draw a list of names.
 */
function VideoAttachment({ attachment, ops }: { attachment: Attachment & { path: string }; ops: WorkbenchOps }) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<string | null>(() => attachmentPreview(attachment.path));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || source || failed) return;
    let active = true;
    loadAttachmentPreview(ops.attachmentBlob, attachment.path, attachment.mimeType)
      .then((preview) => {
        if (!active) return;
        setSource(preview);
        setFailed(preview === null);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [open, attachment.path, attachment.mimeType, ops, source, failed]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Play ${attachment.name}`}
        className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
      >
        <Film className="h-3.5 w-3.5" /> {attachment.name}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onClose={() => setOpen(false)} className="max-w-4xl">
          <DialogTitle>{attachment.name}</DialogTitle>
          {source ? (
            <video src={source} controls autoPlay aria-label={attachment.name} className="mt-3 max-h-[75vh] w-full bg-black" />
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">{failed ? 'Video unavailable.' : 'Loading video…'}</p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ImageAttachment({ attachment, ops }: { attachment: Attachment; ops: WorkbenchOps }) {
  const [source, setSource] = useState(() => (attachment.path ? attachmentPreview(attachment.path) : null));
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const image = attachment.mimeType.startsWith('image/');

  useEffect(() => {
    if (!image || !attachment.path || source || failed) return;
    let active = true;
    loadAttachmentPreview(ops.attachmentBlob, attachment.path, attachment.mimeType)
      .then((preview) => {
        if (!active) return;
        setSource(preview);
        setFailed(preview === null);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [attachment.path, attachment.mimeType, image, ops, source, failed]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  if (!image || failed || !attachment.path) {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground">
        <FileIcon className="h-3.5 w-3.5" /> {attachment.name}
        {image && (failed || !attachment.path) && ' · Image unavailable'}
      </span>
    );
  }
  if (!source)
    return (
      <div aria-label={`Loading ${attachment.name}`} className="h-24 w-32 rounded border border-border bg-background" />
    );
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open ${attachment.name}`}
        className="rounded border border-border p-1"
      >
        <img src={source} alt={attachment.name} className="max-h-40 max-w-56 rounded object-contain" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onClose={() => setOpen(false)} className="max-w-4xl">
          <DialogTitle>{attachment.name}</DialogTitle>
          <img src={source} alt={attachment.name} className="mt-3 max-h-[75vh] w-full object-contain" />
        </DialogContent>
      </Dialog>
    </>
  );
}
