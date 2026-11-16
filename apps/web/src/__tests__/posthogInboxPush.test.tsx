import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import type { InboundDeliverySummary, PostHogInboxPushSummary, PostHogInboxStatus } from '@talyn/shared';
import { api } from '../lib/api';
import { useNavigationStore } from '../stores/navigation';
import { useWorkspaceStore } from '../stores/workspace';
import {
  PostHogInboxConnectionNotice,
  PostHogInboxConnectionSection,
} from '../components/panels/workflows/posthogInboxFields';
import { postHogInboxPushLine } from '../components/panels/workflows/posthogInboxPush';

/**
 * The PostHog Inbox push on web: the Connection tab makes, rotates and
 * removes the webhook URL, shows the URL and secret once with the PostHog
 * steps, the last push and the requests; the rule editor shows the push line.
 */

function inboxStatus(over: Partial<PostHogInboxStatus> = {}): PostHogInboxStatus {
  return {
    access: 'ok',
    reason: null,
    authMethod: 'oauth',
    projectId: '42',
    host: 'https://us.posthog.com',
    connection: 'posthog_inbox',
    missingScopes: [],
    oauthAvailable: true,
    lastPolledAt: null,
    lastError: null,
    lastPushAt: null,
    pushConfigured: false,
    ...over,
  };
}

const SUMMARY: PostHogInboxPushSummary = {
  connectionId: 'c1',
  urlPrefix: 'https://api.talyn.test/api/v1/webhooks/in/c1/',
  projectId: '42',
  secretRequired: true,
  createdAt: '2026-11-16T10:00:00Z',
  rotatedAt: null,
  lastDeliveryAt: '2026-11-16T11:00:00Z',
  lastPushAt: new Date(Date.now() - 60_000).toISOString(),
};

const DELIVERY: InboundDeliverySummary = {
  id: 'd1',
  connectionId: 'c1',
  deliveryId: 'evt-1',
  eventType: '$signals_report_ready',
  receivedAt: new Date().toISOString(),
  processedAt: new Date().toISOString(),
  attempts: 1,
  outcome: 'ignored',
  error: 'PostHog project 42 has no report r9. Talyn dropped the request.',
  replayOf: null,
  payloadBytes: 512,
};

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

beforeEach(() => {
  useNavigationStore.setState({ navigate: vi.fn() } as never);
  useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' } as never);
  vi.spyOn(api.workflows, 'posthogInboxStatus').mockResolvedValue(inboxStatus());
  vi.spyOn(api.workflows, 'posthogInboxWebhook').mockResolvedValue(null);
  vi.spyOn(api.workflows, 'posthogInboxDeliveries').mockResolvedValue([DELIVERY]);
  vi.spyOn(api.workflows, 'posthogInboxDelivery').mockResolvedValue({
    ...DELIVERY,
    payload: { event: { properties: { report_id: 'r9' } } },
    headers: { 'content-type': 'application/json' },
  });
  vi.spyOn(api.workflows, 'replayPostHogInboxDelivery').mockResolvedValue({ ...DELIVERY, id: 'd2' });
  vi.spyOn(api.workflows, 'rotatePostHogInboxWebhook').mockResolvedValue({
    connectionId: 'c1',
    url: 'https://api.talyn.test/api/v1/webhooks/in/c1/tok_secret_part',
    secret: 'whsec_shown_once',
    secretHeader: 'x-talyn-secret',
  });
  vi.spyOn(api.workflows, 'removePostHogInboxWebhook').mockResolvedValue({ removed: 1 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the Connection tab', () => {
  it('offers a URL with a secret, and shows the URL, the header and the secret once', async () => {
    render(<PostHogInboxConnectionSection />);
    const create = await screen.findByRole('button', { name: 'Make a webhook URL' });
    const steps = document.querySelector('[data-attr="posthog-inbox-push-steps"]') as HTMLElement;
    expect(within(steps).getByText(/HTTP Webhook when an Inbox report is ready/)).toBeTruthy();
    expect(within(steps).getByText('X-Talyn-Secret')).toBeTruthy();

    fireEvent.click(create);
    await waitFor(() => expect(api.workflows.rotatePostHogInboxWebhook).toHaveBeenCalledWith('ws1', true));
    const dialog = await screen.findByRole('dialog', { name: 'Copy the PostHog webhook URL' });
    expect(within(dialog).getByTestId('posthog-inbox-push-url').textContent).toBe(
      'https://api.talyn.test/api/v1/webhooks/in/c1/tok_secret_part'
    );
    expect(within(dialog).getByTestId('posthog-inbox-push-header').textContent).toBe('X-Talyn-Secret');
    expect(within(dialog).getByTestId('posthog-inbox-push-secret').textContent).toBe('whsec_shown_once');
    expect(api.workflows.posthogInboxWebhook).toHaveBeenCalledTimes(2);

    fireEvent.click(within(dialog).getByText('Done'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Copy the PostHog webhook URL' })).toBeNull());
    expect(document.body.textContent).not.toContain('whsec_shown_once');
  });

  it('makes a URL without a secret when the box is cleared', async () => {
    vi.mocked(api.workflows.rotatePostHogInboxWebhook).mockResolvedValue({
      connectionId: 'c1',
      url: 'https://api.talyn.test/api/v1/webhooks/in/c1/tok',
      secret: null,
      secretHeader: 'x-talyn-secret',
    });
    render(<PostHogInboxConnectionSection />);
    const box = (await screen.findByText(/Require a secret header/)).querySelector('input') as HTMLInputElement;
    fireEvent.click(box);
    const steps = document.querySelector('[data-attr="posthog-inbox-push-steps"]') as HTMLElement;
    expect(within(steps).queryByText('X-Talyn-Secret')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Make a webhook URL' }));
    await waitFor(() => expect(api.workflows.rotatePostHogInboxWebhook).toHaveBeenCalledWith('ws1', false));
    const dialog = await screen.findByRole('dialog', { name: 'Copy the PostHog webhook URL' });
    expect(within(dialog).queryByTestId('posthog-inbox-push-secret')).toBeNull();
  });

  it('shows the URL without its token, the last push and the requests', async () => {
    vi.mocked(api.workflows.posthogInboxWebhook).mockResolvedValue(SUMMARY);
    render(<PostHogInboxConnectionSection />);
    expect((await screen.findByTestId('posthog-inbox-push-url-prefix')).textContent).toBe(`${SUMMARY.urlPrefix}…`);
    expect(screen.getByTestId('posthog-inbox-push-last').textContent).toMatch(/Last push from PostHog: .*every 30 minutes/);
    expect(screen.getByText(/Secret header required/)).toBeTruthy();
    expect(await screen.findByText(/has no report r9/)).toBeTruthy();
    expect(api.workflows.posthogInboxDeliveries).toHaveBeenCalledWith('ws1', { limit: 25, cursor: null });

    fireEvent.click(screen.getByRole('button', { name: /Request \$signals_report_ready/ }));
    expect(await screen.findByTestId('webhook-delivery-payload')).toBeTruthy();
    expect(api.workflows.posthogInboxDelivery).toHaveBeenCalledWith('ws1', 'd1');

    fireEvent.click(screen.getByRole('button', { name: 'Replay request d1' }));
    await waitFor(() => expect(api.workflows.replayPostHogInboxDelivery).toHaveBeenCalledWith('ws1', 'd1'));
  });

  it('rotates after a confirm, keeping the secret choice', async () => {
    vi.mocked(api.workflows.posthogInboxWebhook).mockResolvedValue({ ...SUMMARY, secretRequired: false });
    render(<PostHogInboxConnectionSection />);
    fireEvent.click(await screen.findByRole('button', { name: /Rotate URL/ }));
    expect(screen.getByText(/the new URL needs no secret/)).toBeTruthy();
    const confirm = screen.getAllByRole('button', { name: 'Rotate URL' }).at(-1)!;
    fireEvent.click(confirm);
    await waitFor(() => expect(api.workflows.rotatePostHogInboxWebhook).toHaveBeenCalledWith('ws1', false));
  });

  it('removes the URL after a confirm', async () => {
    vi.mocked(api.workflows.posthogInboxWebhook).mockResolvedValue(SUMMARY);
    render(<PostHogInboxConnectionSection />);
    fireEvent.click(await screen.findByRole('button', { name: /Remove URL/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove URL' }).at(-1)!);
    await waitFor(() => expect(api.workflows.removePostHogInboxWebhook).toHaveBeenCalledWith('ws1'));
  });

  it('shows no push section until PostHog is connected', async () => {
    vi.mocked(api.workflows.posthogInboxStatus).mockResolvedValue(
      inboxStatus({ access: 'not_connected', projectId: null, authMethod: null })
    );
    render(<PostHogInboxConnectionSection />);
    // The Inbox's own connection card says it is not connected.
    expect(await screen.findByText('Not connected')).toBeTruthy();
    expect(document.querySelector('[data-attr="posthog-inbox-push-section"]')).toBeNull();
    expect(api.workflows.posthogInboxWebhook).not.toHaveBeenCalled();
  });

  it('says when the URL could not be loaded', async () => {
    vi.mocked(api.workflows.posthogInboxWebhook).mockRejectedValue(new Error('boom'));
    render(<PostHogInboxConnectionSection />);
    expect(await screen.findByText('boom')).toBeTruthy();
  });
});

describe('the rule editor notice', () => {
  it.each<[string, Partial<PostHogInboxStatus>, RegExp]>([
    ['no push', {}, /set up the push on the Connection tab/],
    ['a URL without a push yet', { pushConfigured: true }, /no push from PostHog has arrived yet/],
    ['a recent push', { pushConfigured: true, lastPushAt: new Date().toISOString() }, /Last push from PostHog: .*every 30 minutes/],
    [
      'an old push',
      { pushConfigured: true, lastPushAt: new Date(Date.now() - 2 * 86_400_000).toISOString() },
      /No push in the last 24 hours/,
    ],
  ])('%s', (_name, over, text) => {
    render(<PostHogInboxConnectionNotice status={inboxStatus(over)} error={null} />);
    expect(document.querySelector('[data-attr="posthog-inbox-push-status"]')?.textContent).toMatch(text);
  });
});

describe('postHogInboxPushLine', () => {
  const now = Date.now();
  it.each<[string | null, boolean, RegExp]>([
    [null, false, /does not push to Talyn yet\. Talyn checks the Inbox every 3 minutes/],
    [null, true, /no push from PostHog has arrived yet/],
    [new Date(now - 1000).toISOString(), true, /also checks the Inbox every 30 minutes/],
    [new Date(now - 23 * 3_600_000).toISOString(), true, /every 30 minutes/],
    [new Date(now - 25 * 3_600_000).toISOString(), true, /No push in the last 24 hours/],
    ['not a time', true, /Last push from PostHog: never/],
  ])('%s, configured %s', (at, configured, text) => {
    expect(postHogInboxPushLine(at, configured)).toMatch(text);
  });
});
