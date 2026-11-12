import React, { useEffect, useRef, useState } from 'react';
import { Film, ImageIcon, ImagePlus, Loader2, X } from 'lucide-react';
import {
  isWorkbenchVideoType,
  workbenchQueuesMessages,
  WORKBENCH_ATTACHMENT_EXTENSIONS,
  WORKBENCH_IMAGE_TYPES,
  WORKBENCH_MAX_VIDEO_BYTES,
  WORKBENCH_VIDEO_TYPES,
  type WorkbenchAttachment,
  type WorkbenchStatus,
} from '@talyn/shared';
import { downscaleImage } from '../../lib/imageDownscale';
import { attachmentPreview, rememberAttachmentBlob, rememberAttachmentPreview } from '../../lib/attachmentPreviews';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { toast } from '../../stores/toast';

const LARGE_PNG_BYTES = 1.5 * 1024 * 1024;
const IMAGE_TYPES = WORKBENCH_IMAGE_TYPES.join(',');
const MEDIA_TYPES = [...WORKBENCH_IMAGE_TYPES, ...WORKBENCH_VIDEO_TYPES, '.mov', '.m4v'].join(',');

/** A file the composer takes: an image (any type the browser decodes) or a video. */
const isMedia = (type: string) => type.startsWith('image/') || type.startsWith('video/');

/**
 * The upload type of a video file, or null when the session cannot take it.
 * Some systems give `.mov` and `.m4v` files no type or a vendor type, so the extension decides then.
 */
export function videoUploadType(file: Pick<File, 'name' | 'type'>): string | null {
  const declared = file.type.toLowerCase() === 'video/x-m4v' ? 'video/mp4' : file.type.toLowerCase();
  if (isWorkbenchVideoType(declared)) return declared;
  if (declared && declared !== 'application/octet-stream' && !declared.startsWith('video/')) return null;
  const extension = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
  const byName = WORKBENCH_ATTACHMENT_EXTENSIONS[extension];
  return byName && isWorkbenchVideoType(byName) ? byName : null;
}

const isVideoFile = (file: File) =>
  file.type.startsWith('video/') || (!file.type.startsWith('image/') && videoUploadType(file) !== null);

export function useComposerImages(runtime: 'sandbox' | 'local', ops?: WorkbenchOps, status?: WorkbenchStatus) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<WorkbenchAttachment[]>([]);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [imageNotReady, setImageNotReady] = useState(false);

  const attachFiles = async (files: File[]) => {
    if (files.length === 0) return;
    if (ops && (ops.unavailable || !ops.canAttach)) {
      if (runtime === 'sandbox' && status && workbenchQueuesMessages(status)) setImageNotReady(true);
      else toast.error('Could not attach the file', ops.unavailable ?? 'Attachments are unavailable.');
      return;
    }
    setImageNotReady(false);
    setPendingUploads((count) => count + files.length);
    for (const file of files) {
      if (isVideoFile(file)) {
        try {
          await attachVideo(file);
        } catch (err) {
          toast.error('Could not attach the video', err instanceof Error ? err.message : undefined);
        } finally {
          setPendingUploads((count) => count - 1);
        }
        continue;
      }
      try {
        let dataUrl = await downscaleImage(file, 1600);
        let mimeType = 'image/png';
        let name = file.name || 'pasted.png';
        if (runtime === 'sandbox' && atob(dataUrl.slice(dataUrl.indexOf(',') + 1)).length > LARGE_PNG_BYTES) {
          dataUrl = await downscaleImage(file, 1600, 'image/jpeg', 0.85);
          mimeType = 'image/jpeg';
          name = name.replace(/\.[^.]+$/, '') + '.jpg';
        }
        const dataBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        const attachment = ops ? await ops.attach({ name, mimeType, dataBase64 }) : { name, mimeType, dataBase64 };
        if (attachment.path) rememberAttachmentPreview(attachment.path, dataUrl);
        setAttachments((current) => [...current, attachment]);
      } catch (err) {
        toast.error('Could not attach the image', err instanceof Error ? err.message : undefined);
      } finally {
        setPendingUploads((count) => count - 1);
      }
    }
  };

  // A video goes up as it is: no re-encoding, and never inline, because the
  // JSON body of a message is capped far below a video's size.
  const attachVideo = async (file: File) => {
    const mimeType = videoUploadType(file);
    if (!mimeType) throw new Error('Only MP4, MOV and WebM videos can be attached.');
    if (!ops) throw new Error('Videos can be attached once the session has started.');
    if (file.size === 0) throw new Error('The video is empty.');
    if (file.size > WORKBENCH_MAX_VIDEO_BYTES) throw new Error('The video is larger than 50 MB.');
    const name = file.name || 'video';
    const attachment = await ops.attach({ name, mimeType, blob: file });
    if (attachment.path) rememberAttachmentBlob(attachment.path, file);
    setAttachments((current) => [...current, attachment]);
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === 'file' && isMedia(item.type))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    void attachFiles(files);
  };

  return {
    attachments, setAttachments, pendingUploads, imageNotReady, setImageNotReady,
    fileInputRef, attachFiles, onPaste,
    clear: () => { setAttachments([]); setImageNotReady(false); },
  };
}

const carriesFiles = (event: { dataTransfer: DataTransfer | null }) =>
  [...(event.dataTransfer?.types ?? [])].includes('Files');

/**
 * Makes an element a drop target for images from the OS or another app.
 * Drags without files (selected text, list reordering) pass through untouched.
 * A file dropped next to the zone is swallowed, so the browser does not open it in place of the app.
 */
export function useImageDropZone(onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const guard = (event: DragEvent) => {
      if (!carriesFiles(event) || event.defaultPrevented) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    };
    const reset = () => { depth.current = 0; setDragging(false); };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    window.addEventListener('drop', reset);
    window.addEventListener('dragend', reset);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
      window.removeEventListener('drop', reset);
      window.removeEventListener('dragend', reset);
    };
  }, []);

  const dropProps = {
    onDragEnter: (event: React.DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: React.DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (event: React.DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = [...event.dataTransfer.files];
      const media = files.filter((file) => isMedia(file.type) || videoUploadType(file) !== null);
      if (media.length > 0) onFiles(media);
      else if (files.length > 0) toast.error('Could not attach the file', 'Only images and videos can be attached.');
    },
  };

  return { dragging, dropProps };
}

export function ImageDropOverlay({ dragging, className }: { dragging: boolean; className?: string }) {
  if (!dragging) return null;
  return (
    <div
      data-attr="image-drop-overlay"
      className={`pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-primary/60 bg-background/80 ${className ?? ''}`}
    >
      <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
        <ImagePlus className="h-4 w-4" /> Drop images or videos to attach
      </span>
    </div>
  );
}

export function ImageAttachmentChips({
  attachments, pendingUploads, imageNotReady, onRemove,
}: {
  attachments: WorkbenchAttachment[];
  pendingUploads: number;
  imageNotReady: boolean;
  onRemove: (index: number) => void;
}) {
  if (attachments.length === 0 && pendingUploads === 0 && !imageNotReady) return null;
  return (
    <div className="flex flex-wrap gap-1 px-2 pt-2">
      {attachments.map((attachment, index) => (
        <span key={`${attachment.path ?? attachment.name}-${index}`} className="inline-flex items-center gap-1.5 rounded bg-muted py-1 pl-1 pr-1.5 text-[11px]">
          <AttachmentThumbnail attachment={attachment} />
          {attachment.name}
          <button type="button" onClick={() => onRemove(index)} aria-label={`Remove ${attachment.name}`}>
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      {pendingUploads > 0 && <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px]"><Loader2 className="h-3 w-3 animate-spin" /> Uploading…</span>}
      {imageNotReady && <span className="text-[11px] text-amber-700 dark:text-amber-400">Files can be attached once the sandbox is ready.</span>}
    </div>
  );
}

function composerPreview(attachment: WorkbenchAttachment): string | null {
  if (attachment.dataBase64) return `data:${attachment.mimeType};base64,${attachment.dataBase64}`;
  return attachment.path ? attachmentPreview(attachment.path) : null;
}

function AttachmentThumbnail({ attachment }: { attachment: WorkbenchAttachment }) {
  const [failed, setFailed] = useState(false);
  if (isWorkbenchVideoType(attachment.mimeType)) {
    return (
      <span className="flex h-8 w-8 items-center justify-center rounded-sm bg-background" aria-label="Video">
        <Film className="h-3.5 w-3.5" />
      </span>
    );
  }
  const source = attachment.mimeType.startsWith('image/') && !failed ? composerPreview(attachment) : null;
  if (!source) {
    return (
      <span className="flex h-8 w-8 items-center justify-center rounded-sm bg-background">
        <ImageIcon className="h-3.5 w-3.5" />
      </span>
    );
  }
  return <img src={source} alt="" className="h-8 w-8 rounded-sm bg-background object-cover" onError={() => setFailed(true)} />;
}

/** `videos`: also offer videos. Only a started session can take one, so the new-session page leaves it off. */
export function ImageAttachButton({ inputRef, onFiles, videos = false }: { inputRef: React.RefObject<HTMLInputElement | null>; onFiles: (files: File[]) => void; videos?: boolean }) {
  const label = videos ? 'Attach images or videos' : 'Attach images';
  return (
    <>
      <input ref={inputRef} type="file" accept={videos ? MEDIA_TYPES : IMAGE_TYPES} multiple className="hidden" aria-label={videos ? 'Choose images or videos' : 'Choose images'} onChange={(event) => {
        onFiles([...(event.target.files ?? [])]);
        event.target.value = '';
      }} />
      <button type="button" onClick={() => inputRef.current?.click()} className="rounded p-1 hover:bg-accent" aria-label={label} title={label}>
        <ImageIcon className="h-4 w-4" />
      </button>
    </>
  );
}
