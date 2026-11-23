import '@testing-library/jest-dom';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import type { InboundDeliverySummary, PostHogInboxPushSummary, PostHogInboxStatus } from '@talyn/shared';
import { api } from '../renderer/lib/api';
import { useNavigationStore } from '../renderer/stores/navigation';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import {
  PostHogInboxConnectionNotice,
  PostHogInboxConnectionSection,
} from '../renderer/components/panels/workflows/posthogInboxFields';
import { destinationOutcomeText, postHogInboxPushLine } from '../renderer/components/panels/workflows/posthogInboxPush';
import { toast } from '../renderer/stores/toast';

/**
 * The PostHog Inbox push on desktop: the Connection tab makes, rotates and
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
    pushManaged: false,
    pushSetupMissingScopes: [],
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
  destination: null,
};

const DESTINATION_URL = 'https://us.posthog.com/project/42/functions/hog-1';

const MANAGED: PostHogInboxPushSummary = {
  ...SUMMARY,
  destination: { id: 'hog-1', url: DESTINATION_URL, syncedAt: '2026-11-16T12:00:00Z', error: null },
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
  useNavigationStore.setState({ navigate: jest.fn() } as never);
  useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' } as never);
  jest.spyOn(api.workflows, 'posthogInboxStatus').mockResolvedValue(inboxStatus());
  jest.spyOn(api.workflows, 'posthogInboxWebhook').mockResolvedValue(null);
  jest.spyOn(api.workflows, 'posthogInboxDeliveries').mockResolvedValue([DELIVERY]);
  jest.spyOn(api.workflows, 'posthogInboxDelivery').mockResolvedValue({
    ...DELIVERY,
    payload: { event: { properties: { report_id: 'r9' } } },
    headers: { 'content-type': 'application/json' },
  });
  jest.spyOn(api.workflows, 'replayPostHogInboxDelivery').mockResolvedValue({ ...DELIVERY, id: 'd2' });
  jest.spyOn(api.workflows, 'rotatePostHogInboxWebhook').mockResolvedValue({
    connectionId: 'c1',
    url: 'https://api.talyn.test/api/v1/webhooks/in/c1/tok_secret_part',
    secret: 'whsec_shown_once',
    secretHeader: 'x-talyn-secret',
  });
  jest.spyOn(api.workflows, 'removePostHogInboxWebhook').mockResolvedValue({ removed: 1, destination: null });
  jest.spyOn(api.workflows, 'setUpPostHogInboxPush').mockResolvedValue({
    connectionId: 'c1',
    created: true,
    destination: { id: 'hog-1', url: DESTINATION_URL, syncedAt: '2026-11-16T12:00:00Z', error: null },
  });
  jest.spyOn(api.posthogInbox, 'startOAuth').mockResolvedValue({ authorizeUrl: 'https://us.posthog.com/oauth/authorize' });
  jest.spyOn(toast, 'success');
  jest.spyOn(toast, 'error');
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
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
    jest.mocked(api.workflows.rotatePostHogInboxWebhook).mockResolvedValue({
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
    jest.mocked(api.workflows.posthogInboxWebhook).mockResolvedValue(SUMMARY);
    render(<PostHogInboxConnectionSection />);
    expect((await screen.findByTestId('posthog-inbox-push-url-prefix')).textContent).toBe(`${SUMMARY.urlPrefix}…`);
    expect(screen.getByTestId('posthog-inbox-push-last').textContent).toMatch(/Last push from PostHog: .*every 30 minutes/);
    expect(screen.getByText(/Secret header required/)).toBeTruthy();
    expect(await screen.findByText(/has no report r9/)).toBeTruthy();
    expect(api.workflows.posthogInboxDeliveries).toHaveBeenCalledWith('ws1', { limit: 25, cursor: null });

    fireEvent.click(screen.getByRole('button', { name: 'Show body' }));
    expect(await screen.findByTestId('webhook-delivery-payload')).toBeTruthy();
    expect(api.workflows.posthogInboxDelivery).toHaveBeenCalledWith('ws1', 'd1');

    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    await waitFor(() => expect(api.workflows.replayPostHogInboxDelivery).toHaveBeenCalledWith('ws1', 'd1'));
  });

  it('rotates after a confirm, keeping the secret choice', async () => {
    jest.mocked(api.workflows.posthogInboxWebhook).mockResolvedValue({ ...SUMMARY, secretRequired: false });
    render(<PostHogInboxConnectionSection />);
    fireEvent.click(await screen.findByRole('button', { name: /Rotate URL/ }));
    expect(screen.getByText(/the new URL needs no secret/)).toBeTruthy();
    const confirm = screen.getAllByRole('button', { name: 'Rotate URL' }).at(-1)!;
    fireEvent.click(confirm);
    await waitFor(() => expect(api.workflows.rotatePostHogInboxWebhook).toHaveBeenCalledWith('ws1', false));
  });

  it('removes the URL after a confirm', async () => {
    jest.mocked(api.workflows.posthogInboxWebhook).mockResolvedValue(SUMMARY);
    render(<PostHogInboxConnectionSection />);
    fireEvent.click(await screen.findByRole('button', { name: /Remove URL/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove URL' }).at(-1)!);
    await waitFor(() => expect(api.workflows.removePostHogInboxWebhook).toHaveBeenCalledWith('ws1'));
  });

  it('shows no push section until PostHog is connected', async () => {
    jest.mocked(api.workflows.posthogInboxStatus).mockResolvedValue(
      inboxStatus({ access: 'not_connected', projectId: null, authMethod: null })
    );
    render(<PostHogInboxConnectionSection />);
    // The Inbox's own connection card says it is not connected.
    expect(await screen.findByText('Not connected')).toBeTruthy();
    expect(document.querySelector('[data-attr="posthog-inbox-push-section"]')).toBeNull();
    expect(api.workflows.posthogInboxWebhook).not.toHaveBeenCalled();
  });

  it('says when the URL could not be loaded', async () => {
    jest.mocked(api.workflows.posthogInboxWebhook).mockRejectedValue(new Error('boom'));
    render(<PostHogInboxConnectionSection />);
    expect(await screen.findByText('boom')).toBeTruthy();
  });
});

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('Set up push in PostHog', () => {
  it('is the first choice without a URL: one click, no URL or secret shown', async () => {
    render(<PostHogInboxConnectionSection />);
    const setUp = await screen.findByRole('button', { name: /Set up push in PostHog/ });
    // The manual path stays, below.
    expect(screen.getByRole('button', { name: 'Make a webhook URL' })).toBeTruthy();
    fireEvent.click(setUp);
    await waitFor(() => expect(api.workflows.setUpPostHogInboxPush).toHaveBeenCalledWith('ws1'));
    expect(api.workflows.rotatePostHogInboxWebhook).not.toHaveBeenCalled();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Push is set up in PostHog'));
    expect(screen.queryByRole('dialog', { name: 'Copy the PostHog webhook URL' })).toBeNull();
    expect(api.workflows.posthogInboxWebhook).toHaveBeenCalledTimes(2);
  });

  it.each<[string, string[]]>([
    ['both scopes', ['hog_function:read', 'hog_function:write']],
    ['the write scope', ['hog_function:write']],
  ])('asks for a reconnect when the grant lacks %s, and keeps the manual path', async (_label, missing) => {
    jest.mocked(api.workflows.posthogInboxStatus).mockResolvedValue(inboxStatus({ pushSetupMissingScopes: missing }));
    render(<PostHogInboxConnectionSection />);
    const notice = (await screen.findByText('Reconnect PostHog to let Talyn set up push.')).closest(
      '[data-attr="posthog-inbox-push-reconnect"]'
    ) as HTMLElement;
    expect(notice.textContent).toContain(missing.join(' and '));
    expect(notice.textContent).toContain('Your automations keep working');
    // The connection card itself does not say the connection is broken.
    expect(document.querySelector('[data-attr="posthog-inbox-reconnect-notice"]')).toBeNull();
    expect((screen.getByRole('button', { name: /Set up push in PostHog/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Make a webhook URL' }) as HTMLButtonElement).disabled).toBe(false);

    // The desktop opens the PostHog sign-in in the system browser.
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    fireEvent.click(within(notice).getByRole('button', { name: /Reconnect/ }));
    await waitFor(() => expect(api.posthogInbox.startOAuth).toHaveBeenCalledWith('ws1', expect.objectContaining({ projectId: '42' })));
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://us.posthog.com/oauth/authorize', '_blank', 'noopener,noreferrer'));
  });

  it('asks for a reconnect when the backend refuses for missing scopes', async () => {
    jest.mocked(api.workflows.setUpPostHogInboxPush).mockRejectedValue(
      codedError('Reconnect PostHog to let Talyn set up push. The connection lacks hog_function:write.', 'posthog_inbox_push_scopes_missing')
    );
    render(<PostHogInboxConnectionSection />);
    fireEvent.click(await screen.findByRole('button', { name: /Set up push in PostHog/ }));
    expect(await screen.findByText('Reconnect PostHog to let Talyn set up push.')).toBeTruthy();
    expect(screen.queryByTestId('posthog-inbox-push-setup-error')).toBeNull();
  });

  it.each([
    ['posthog_inbox_push_forbidden', 'PostHog refused to save the destination (403). Talyn did not change the webhook URL.'],
    ['posthog_inbox_push_failed', 'PostHog did not answer as expected (503). Try again later. Talyn did not change the webhook URL.'],
  ])('shows PostHog\'s refusal (%s) and leaves the URL alone', async (code, message) => {
    jest.mocked(api.workflows.setUpPostHogInboxPush).mockRejectedValue(codedError(message, code));
    render(<PostHogInboxConnectionSection />);
    fireEvent.click(await screen.findByRole('button', { name: /Set up push in PostHog/ }));
    expect((await screen.findByTestId('posthog-inbox-push-setup-error')).textContent).toBe(message);
    expect(screen.queryByText('Reconnect PostHog to let Talyn set up push.')).toBeNull();
  });

  it('over a URL made by hand, asks first and warns that the hand-made destination stops working', async () => {
    jest.mocked(api.workflows.posthogInboxWebhook).mockResolvedValue(SUMMARY);
    render(<PostHogInboxConnectionSection />);
    fireEvent.click(await screen.findByRole('button', { name: /Set up push in PostHog/ }));
    expect(api.workflows.setUpPostHogInboxPush).not.toHaveBeenCalled();
    expect(screen.getByText(/A destination you added by hand stops working/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Set up push' }));
    await waitFor(() => expect(api.workflows.setUpPostHogInboxPush).toHaveBeenCalledWith('ws1'));
  });

  it('shows a destination Talyn manages, with its PostHog link, and hides the manual steps', async () => {
    jest.mocked(api.workflows.posthogInboxWebhook).mockResolvedValue(MANAGED);
    render(<PostHogInboxConnectionSection />);
    const managed = (await screen.findByText(/Talyn set up the destination in PostHog/)).closest(
      '[data-attr="posthog-inbox-push-managed"]'
    ) as HTMLElement;
    const link = within(managed).getByRole('link', { name: /Open the destination in PostHog/ }) as HTMLAnchorElement;
    expect(link.href).toBe(DESTINATION_URL);
    expect(link.target).toBe('_blank');
    expect(document.querySelector('[data-attr="posthog-inbox-push-steps"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /Set up push in PostHog/ })).toBeNull();
    expect(screen.queryByText(/Require a secret header/)).toBeNull();
    expect(screen.getByTestId('posthog-inbox-push-last').textContent).toMatch(/Last push from PostHog/);
  });

  it('says when the destination is out of date, and offers to update it', async () => {
    const error = 'Talyn changed the webhook URL, but PostHog did not take the change. The destination still sends to the old URL.';
    jest.mocked(api.workflows.posthogInboxWebhook).mockResolvedValue({ ...MANAGED, destination: { ...MANAGED.destination!, error } });
    render(<PostHogInboxConnectionSection />);
    expect((await screen.findByTestId('posthog-inbox-push-out-of-date')).textContent).toContain(error);
    fireEvent.click(screen.getByRole('button', { name: /Update the destination in PostHog/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Set up push' }));
    await waitFor(() => expect(api.workflows.setUpPostHogInboxPush).toHaveBeenCalledWith('ws1'));
  });

  it('a rotate PostHog took shows no URL or secret', async () => {
    jest.mocked(api.workflows.posthogInboxWebhook).mockResolvedValue(MANAGED);
    jest.mocked(api.workflows.rotatePostHogInboxWebhook).mockResolvedValue({
      connectionId: 'c1',
      url: 'https://api.talyn.test/api/v1/webhooks/in/c1/tok_secret_part',
      secret: 'whsec_shown_once',
      secretHeader: 'x-talyn-secret',
      destination: { state: 'updated', error: null, url: DESTINATION_URL },
    });
    render(<PostHogInboxConnectionSection />);
    fireEvent.click(await screen.findByRole('button', { name: /Rotate URL/ }));
    expect(screen.getByText(/Talyn gives the new ones to its destination in PostHog/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Rotate URL' }).at(-1)!);
    await waitFor(() => expect(api.workflows.rotatePostHogInboxWebhook).toHaveBeenCalledWith('ws1', true));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('URL rotated', 'PostHog has the new URL and secret.'));
    expect(screen.queryByRole('dialog', { name: 'Copy the PostHog webhook URL' })).toBeNull();
    expect(document.body.textContent).not.toContain('whsec_shown_once');
  });

  it('a rotate PostHog did not take says so, and shows the URL and secret once to fix it by hand', async () => {
    const error = 'Talyn changed the webhook URL, but PostHog did not take the change. PostHog refused to save the destination (403).';
    jest.mocked(api.workflows.posthogInboxWebhook).mockResolvedValue(MANAGED);
    jest.mocked(api.workflows.rotatePostHogInboxWebhook).mockResolvedValue({
      connectionId: 'c1',
      url: 'https://api.talyn.test/api/v1/webhooks/in/c1/tok',
      secret: 'whsec_x',
      secretHeader: 'x-talyn-secret',
      destination: { state: 'failed', error, url: DESTINATION_URL },
    });
    render(<PostHogInboxConnectionSection />);
    fireEvent.click(await screen.findByRole('button', { name: /Rotate URL/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Rotate URL' }).at(-1)!);
    const dialog = await screen.findByRole('dialog', { name: 'Copy the PostHog webhook URL' });
    expect(within(dialog).getByTestId('posthog-inbox-push-reveal-destination-error').textContent).toBe(error);
    expect(toast.error).toHaveBeenCalledWith('The destination in PostHog is out of date', error);
  });

  it.each<[string, { state: 'deleted' | 'not_found' | 'failed'; error: string | null } | null, 'success' | 'error', RegExp]>([
    ['deleted', { state: 'deleted', error: null }, 'success', /deleted its destination/],
    ['already gone', { state: 'not_found', error: null }, 'success', /already gone/],
    ['not deleted', { state: 'failed', error: 'PostHog refused. Delete the destination in PostHog.' }, 'error', /Delete the destination in PostHog/],
  ])('removing a managed URL: destination %s', async (_label, outcome, kind, text) => {
    jest.mocked(api.workflows.posthogInboxWebhook).mockResolvedValue(MANAGED);
    jest.mocked(api.workflows.removePostHogInboxWebhook).mockResolvedValue({
      removed: 1,
      destination: outcome ? { ...outcome, url: DESTINATION_URL } : null,
    });
    render(<PostHogInboxConnectionSection />);
    fireEvent.click(await screen.findByRole('button', { name: /Remove URL/ }));
    expect(screen.getByText(/Talyn deletes its destination in PostHog/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove URL' }).at(-1)!);
    await waitFor(() => expect(toast[kind]).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(text)));
  });
});

describe('destinationOutcomeText', () => {
  it.each<[Parameters<typeof destinationOutcomeText>[0], 'rotate' | 'remove', string | null]>([
    [null, 'rotate', null],
    [undefined, 'remove', null],
    [{ state: 'updated', error: null, url: null }, 'rotate', 'PostHog has the new URL and secret.'],
    [{ state: 'deleted', error: null, url: null }, 'remove', 'Talyn deleted its destination in PostHog.'],
    [{ state: 'not_found', error: null, url: null }, 'rotate', 'The destination Talyn made is gone from PostHog. Set up push again to make a new one.'],
    [{ state: 'not_found', error: null, url: null }, 'remove', 'The destination was already gone from PostHog.'],
    [{ state: 'failed', error: 'boom', url: null }, 'rotate', 'boom'],
    [{ state: 'failed', error: null, url: null }, 'remove', 'PostHog did not take the change.'],
  ])('%j on %s', (outcome, action, expected) => {
    expect(destinationOutcomeText(outcome, action)).toBe(expected);
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
