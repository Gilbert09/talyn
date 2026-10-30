import React, { useRef, useState } from 'react';
import { ImageIcon, Loader2, X } from 'lucide-react';
import { workbenchQueuesMessages, type WorkbenchAttachment, type WorkbenchStatus } from '@talyn/shared';
import { downscaleImage } from '../../lib/imageDownscale';
import { rememberAttachmentPreview } from '../../lib/attachmentPreviews';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { toast } from '../../stores/toast';

const LARGE_PNG_BYTES = 1.5 * 1024 * 1024;
const IMAGE_TYPES = 'image/png,image/jpeg,image/webp,image/gif';

export function useComposerImages(runtime: 'sandbox' | 'local', ops?: WorkbenchOps, status?: WorkbenchStatus) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<WorkbenchAttachment[]>([]);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [imageNotReady, setImageNotReady] = useState(false);

  const attachFiles = async (files: File[]) => {
    if (files.length === 0) return;
    if (ops && (ops.unavailable || !ops.canAttach)) {
      if (runtime === 'sandbox' && status && workbenchQueuesMessages(status)) setImageNotReady(true);
      else toast.error('Could not attach the image', ops.unavailable ?? 'Attachments are unavailable.');
      return;
    }
    setImageNotReady(false);
    setPendingUploads((count) => count + files.length);
    for (const file of files) {
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

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    void attachFiles(files);
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    void attachFiles([...event.dataTransfer.files].filter((file) => file.type.startsWith('image/')));
  };

  return {
    attachments, setAttachments, pendingUploads, imageNotReady, setImageNotReady,
    fileInputRef, attachFiles, onPaste, onDrop,
    clear: () => { setAttachments([]); setImageNotReady(false); },
  };
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
        <span key={`${attachment.path ?? attachment.name}-${index}`} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px]">
          <ImageIcon className="h-3 w-3" />
          {attachment.name}
          <button type="button" onClick={() => onRemove(index)} aria-label={`Remove ${attachment.name}`}>
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      {pendingUploads > 0 && <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px]"><Loader2 className="h-3 w-3 animate-spin" /> Uploading image…</span>}
      {imageNotReady && <span className="text-[11px] text-amber-700 dark:text-amber-400">Images can be attached once the sandbox is ready.</span>}
    </div>
  );
}

export function ImageAttachButton({ inputRef, onFiles }: { inputRef: React.RefObject<HTMLInputElement | null>; onFiles: (files: File[]) => void }) {
  return (
    <>
      <input ref={inputRef} type="file" accept={IMAGE_TYPES} multiple className="hidden" aria-label="Choose images" onChange={(event) => {
        onFiles([...(event.target.files ?? [])]);
        event.target.value = '';
      }} />
      <button type="button" onClick={() => inputRef.current?.click()} className="rounded p-1 hover:bg-accent" aria-label="Attach images" title="Attach images">
        <ImageIcon className="h-4 w-4" />
      </button>
    </>
  );
}
