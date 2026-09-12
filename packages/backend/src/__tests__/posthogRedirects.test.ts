import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { PostHogCodeClient } from '../services/posthogCode/client.js';
import { completeAuthorization } from '../services/posthogCode/oauth.js';
import { resetPostHogOAuthConfigForTests } from '../services/posthogCode/oauthConfig.js';

const HOST = 'https://us.posthog.com';
const previousDispatcher = getGlobalDispatcher();
let agent: MockAgent;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  vi.stubEnv('POSTHOG_ALLOWED_ORIGINS', '');
  vi.stubEnv('POSTHOG_OAUTH_CLIENT_ID', 'test-client');
  vi.stubEnv('POSTHOG_OAUTH_REDIRECT_URI', 'https://talyn.example/callback');
  resetPostHogOAuthConfigForTests();
});

afterEach(async () => {
  setGlobalDispatcher(previousDispatcher);
  await agent.close();
  vi.unstubAllEnvs();
  resetPostHogOAuthConfigForTests();
});

describe.each(['api', 'stream', 'token', 'introspection'])('native fetch redirects: %s', (kind) => {
  it.each([301, 302, 303, 307, 308])('never follows HTTP %s with credentials', async (status) => {
    const redirected = vi.fn(() => ({ statusCode: 200, data: '{}' }));
    agent.get('https://127.0.0.1').intercept({ path: '/stolen', method: /.+/ }).reply(redirected);
    const path = kind === 'api' ? '/api/projects/1/tasks/task/'
      : kind === 'stream' ? '/api/projects/1/tasks/task/runs/run/stream/'
        : kind === 'token' ? '/oauth/token/' : '/oauth/introspect/';
    const method = kind === 'api' ? 'PATCH' : kind === 'stream' ? 'GET' : 'POST';
    if (kind === 'introspection') {
      agent.get(HOST).intercept({ path: '/oauth/token/', method: 'POST' }).reply(200, {
        access_token: 'access', refresh_token: 'refresh', expires_in: 3600,
      });
    }
    agent.get(HOST).intercept({ path, method }).reply(status, 'PRIVATE_RESPONSE_MARKER', {
      headers: { location: 'https://127.0.0.1/stolen' },
    });
    const client = new PostHogCodeClient('test-key', '1', HOST);
    const operation = kind === 'api' ? client.updateTask('task', { description: 'private prompt' })
      : kind === 'stream' ? client.openRunStream('task', 'run')
        : completeAuthorization({
          code: 'private-code',
          state: { workspaceId: 'test', userId: 'test', host: HOST, verifier: 'private-verifier', client: 'desktop' },
        });
    await expect(operation).rejects.toThrow();
    expect(redirected).not.toHaveBeenCalled();
  });
});
