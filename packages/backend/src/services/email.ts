import { fetchWithTimeout } from './httpTimeout.js';

/**
 * Outbound email through Resend's HTTP API. Optional: with no
 * `RESEND_API_KEY` the deployment sends no email, and callers fall back to
 * showing the link to the person who asked for it.
 */

const RESEND_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'Talyn <noreply@talyn.dev>';
const SEND_TIMEOUT_MS = 10_000;

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

/** Send one email. True when Resend accepted it. A failure is logged, never thrown. */
export async function sendEmail(message: EmailMessage): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return false;
  const from = process.env.EMAIL_FROM?.trim() || DEFAULT_FROM;
  try {
    const res = await fetchWithTimeout(
      RESEND_URL,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
      },
      { timeoutMs: SEND_TIMEOUT_MS, label: 'Resend' }
    );
    if (!res.ok) {
      console.warn(`Resend refused an email (${res.status}): ${res.bodyText.slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`Resend send failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
