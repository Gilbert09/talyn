import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from './button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';

/**
 * The one way Talyn asks "are you sure?".
 *
 * # Why this replaced click-delete-twice
 *
 * Every delete used to arm itself on the first click and fire on the second,
 * with a toast in between saying "Click delete again to confirm". It is a
 * pattern with three problems, and the third is the one that matters:
 *
 *  - The confirmation is in a TOAST, which is the corner of the screen the user
 *    is not looking at — their cursor is on the button.
 *  - It is armed for four seconds. Miss the window and the second click re-arms
 *    instead of deleting, which reads as the button not working.
 *  - **The same gesture means "ask" and "do".** A double-click, or an
 *    impatient second click on a row that was slow to respond, deletes without
 *    anyone having read anything. A dialog cannot be dismissed by repeating the
 *    action that opened it.
 *
 * # Two deliberate choices
 *
 * **Cancel takes focus by default.** A stray Enter or Space on an opening
 * dialog should do the safe thing. A caller can make Confirm the default when
 * that action is the expected next step.
 *
 * **`busy` disables both buttons rather than only closing on success.** A slow
 * delete otherwise leaves a live Confirm under the cursor, which is the
 * double-fire this dialog exists to prevent, moved one step later.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  busy = false,
  confirmDisabled = false,
  initialFocus = 'cancel',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  /** What is lost, in the user's terms. Omit when the title already says it. */
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** The action is in flight: both buttons lock and Confirm shows a spinner. */
  busy?: boolean;
  /** Confirm stays off, for example while the dialog still reads what is at stake. */
  confirmDisabled?: boolean;
  initialFocus?: 'cancel' | 'confirm';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const confirmRef = React.useRef<HTMLButtonElement>(null);

  // Escape cancels. The Dialog primitive closes on a backdrop click and knows
  // nothing about keys, and a confirmation the keyboard cannot dismiss is one
  // people learn to click through.
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);

  React.useEffect(() => {
    if (!open) return;
    const target = initialFocus === 'confirm' && !confirmDisabled
      ? confirmRef.current
      : cancelRef.current;
    target?.focus();
  }, [open, initialFocus, confirmDisabled]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (busy) return;

    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      cancelRef.current?.focus();
      return;
    }

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      if (!confirmDisabled) confirmRef.current?.focus();
      return;
    }

    if (event.key !== 'Enter') return;
    if (event.target === cancelRef.current) {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.target === confirmRef.current && !confirmDisabled) {
      event.preventDefault();
      event.stopPropagation();
      onConfirm();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <DialogContent
        className="max-w-md"
        role="alertdialog"
        aria-modal="true"
        onKeyDown={onKeyDown}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogFooter>
          <Button
            ref={cancelRef}
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant="destructive"
            size="sm"
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
