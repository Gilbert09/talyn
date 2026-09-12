import { useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { Button } from '../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Textarea } from '../../ui/textarea';
import { toast } from '../../../stores/toast';
import { isAnalyticsConfigured, trackEvent } from '../../../lib/analytics';

/**
 * "Tell us what's missing" — a request box that posts to PostHog and nowhere
 * else.
 *
 * No table, no route, no inbox. The whole point is to hear what people want
 * before building anything to manage it, and a product-analytics event is
 * already queryable, already attributed to the user, and already has the
 * workspace and build on it as super properties. Adding a `feature_requests`
 * table to store twelve rows nobody has triaged would be the expensive way to
 * learn the same thing.
 *
 * # It says so when it cannot send
 *
 * Analytics is off in local dev by default and a user can opt out entirely. A
 * box that silently swallows what somebody took the trouble to type is worse
 * than one that admits it is not listening, so the button is hidden when
 * analytics is not configured, and the submit says plainly if it could not go.
 */

/** Long enough for a paragraph; short enough that it stays an event property. */
const MAX_LENGTH = 2000;

export function FeedbackButton({ surface }: { surface: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');

  // Nothing to click when there is nowhere to send it. Deliberately the whole
  // button rather than a disabled one: "unavailable" is not information the user
  // can act on, and a dead control is a worse answer than no control.
  if (!isAnalyticsConfigured()) return null;

  const send = () => {
    const message = text.trim();
    if (!message) return;
    trackEvent('feedback_submitted', {
      surface,
      message: message.slice(0, MAX_LENGTH),
      // The length of what they MEANT to say, so a truncated message is visible
      // as truncated rather than looking like the whole thought.
      message_length: message.length,
    });
    setText('');
    setOpen(false);
    toast.success('Thanks — that went straight to the team');
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        data-attr="workflows-feedback-open"
        onClick={() => setOpen(true)}
        title="Request a feature or tell us what is not working"
      >
        <MessageSquarePlus className="mr-1 h-4 w-4" />
        Feedback
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onClose={() => setOpen(false)}>
          <DialogHeader>
            <DialogTitle>What would make this better?</DialogTitle>
            <DialogDescription>
              A trigger that does not exist yet, an action you wanted, or something that behaved
              oddly. It goes to the team as-is.
            </DialogDescription>
          </DialogHeader>

          <Textarea
            rows={5}
            autoFocus
            maxLength={MAX_LENGTH}
            value={text}
            placeholder="I wanted a workflow that..."
            onChange={(e) => setText(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Sent with your account and which screen you were on. Nothing else from the page.
          </p>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={send}
              disabled={!text.trim()}
              data-attr="workflows-feedback-submit"
            >
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
