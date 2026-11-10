import { useEffect, useId, useRef, useState } from 'react';
import { Check, Loader2, MessageSquare } from 'lucide-react';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Textarea } from '../ui/textarea';
import { api, type PRReviewEvent, type PRRow } from '../../lib/api';
import { toast } from '../../stores/toast';
import { trackEvent } from '../../lib/analytics';

/** GitHub's own limit on a review body; the backend refuses longer with `body_too_long`. */
const MAX_REVIEW_BODY_CHARS = 65_536;

/**
 * Approve or request changes on a pull request that asked for your review,
 * sent as your own GitHub review. Mirrors the mobile prompt
 * (`PullRequestDetailScreen.tsx`): Approve takes an optional comment, Request
 * changes needs one, because GitHub refuses a change request without a body.
 *
 * The dialog stays open on an error and shows the server's message, so a long
 * comment is not lost to a failed send. Duplicated in apps/web on purpose:
 * the renderer is a deliberate fork.
 */
export function PRReviewDialog({
  event,
  row,
  onClose,
  onSubmitted,
}: {
  /** Which review to send. Null keeps the dialog closed. */
  event: PRReviewEvent | null;
  row: Pick<PRRow, 'id' | 'owner' | 'repo' | 'number'>;
  onClose: () => void;
  /** The refreshed row from the answer, when the backend still has one. */
  onSubmitted?: (row: PRRow | null) => void;
}) {
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // A fresh draft each time the dialog opens, or switches between the two kinds.
  useEffect(() => {
    setBody('');
    setError(null);
    setSubmitting(false);
    if (event) textareaRef.current?.focus();
  }, [event, row.id]);

  // Escape cancels, as in ConfirmDialog: the Dialog primitive knows nothing
  // about keys. Not while a send is in flight, which cannot be taken back.
  useEffect(() => {
    if (!event) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [event, submitting, onClose]);

  if (!event) return null;

  const requestChanges = event === 'request_changes';
  const ref = `${row.owner}/${row.repo}#${row.number}`;
  const text = body.trim();
  const canSubmit = !submitting && (!requestChanges || text.length > 0);

  async function submit() {
    if (!event || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.pullRequests.submitReview(row.id, {
        event,
        ...(text ? { body: text } : {}),
      });
      trackEvent('pr_review_submitted', { event, has_comment: text.length > 0 });
      toast.success(requestChanges ? 'Changes requested' : 'Approved', ref);
      onSubmitted?.(result.row);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : requestChanges
            ? 'Could not request changes. Try again.'
            : 'Could not approve. Try again.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && !submitting && onClose()}>
      <DialogContent
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClose={submitting ? undefined : onClose}
      >
        <DialogHeader>
          <DialogTitle id={titleId}>
            {requestChanges ? `Request changes on ${ref}` : `Approve ${ref}`}
          </DialogTitle>
          <DialogDescription>
            {requestChanges
              ? 'Say what to change. GitHub needs a comment to request changes.'
              : 'A comment is optional.'}
          </DialogDescription>
        </DialogHeader>

        <Textarea
          ref={textareaRef}
          rows={5}
          aria-label={requestChanges ? 'What to change' : 'Comment (optional)'}
          placeholder={requestChanges ? 'What to change' : 'Add a comment'}
          maxLength={MAX_REVIEW_BODY_CHARS}
          value={body}
          disabled={submitting}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter sends; a plain Enter is a new line in the comment.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-500">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={!canSubmit}
            title={requestChanges && !text ? 'Add a comment first' : undefined}
          >
            {submitting ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : requestChanges ? (
              <MessageSquare className="mr-1 h-3.5 w-3.5" />
            ) : (
              <Check className="mr-1 h-3.5 w-3.5" />
            )}
            {requestChanges ? 'Request changes' : 'Approve'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
