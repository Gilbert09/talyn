import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, ImageOff, X } from 'lucide-react';
import { cn } from './utils';

/**
 * An image in rendered markdown (a PR description, a review, a comment, an
 * agent reply). It shows inline and opens a full-size preview on click, so a
 * screenshot can be read without a trip to GitHub.
 *
 * GitHub often wraps an image in a link to itself. The click opens the preview
 * and does not follow that link.
 */
export function MarkdownImage({
  src,
  alt,
  className,
}: {
  src: string | undefined;
  alt: string | undefined;
  className?: string;
}): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!src) return null;
  const label = alt?.trim() || 'Image';
  if (failed) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ImageOff className="h-3.5 w-3.5" />
        {label} · Image unavailable
      </a>
    );
  }
  return (
    <>
      <button
        type="button"
        aria-label={`Open image: ${label}`}
        title="Open image"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
        className="inline-block max-w-full cursor-zoom-in rounded align-top focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <img
          src={src}
          alt={alt}
          onError={() => setFailed(true)}
          className={cn('max-h-96 max-w-full rounded', className)}
        />
      </button>
      {open && (
        <ImageLightbox src={src} alt={label} caption={alt?.trim()} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/**
 * The full-size preview. Portalled to `<body>` because the markdown often sits
 * in a sheet whose transform would trap a `fixed` overlay inside it.
 */
export function ImageLightbox({
  src,
  alt,
  caption,
  onClose,
}: {
  src: string;
  alt: string;
  caption?: string;
  onClose: () => void;
}): React.ReactElement {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    // Capture phase on window, so Escape closes only the preview and not the
    // panel under it (the PR sheet closes on Escape at `document`).
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Image: ${alt}`}
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black/85 p-6"
      onClick={onClose}
    >
      <div className="absolute right-4 top-4 flex items-center gap-2">
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="inline-flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-xs text-white hover:bg-white/20"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open original
        </a>
        <button
          ref={closeRef}
          type="button"
          aria-label="Close image"
          onClick={onClose}
          className="rounded bg-white/10 p-1.5 text-white hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <img
        src={src}
        alt={alt}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[calc(100vh-6rem)] max-w-[calc(100vw-3rem)] rounded object-contain shadow-2xl"
      />
      {caption && <div className="mt-3 max-w-full truncate text-xs text-white/70">{caption}</div>}
    </div>,
    document.body
  );
}
