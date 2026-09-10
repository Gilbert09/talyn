import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';
import {
  isWorkflowsAllowedEmail,
  resetWorkflowsAccessCache,
  workflowsAllowlistIsEmpty,
  workflowsRefusalReason,
  workflowsSubsystemEnabled,
  workspaceMayUseWorkflows,
} from '../services/workflowsAccess.js';

/**
 * The workflows allow-list, mirroring `fleetAccess.test.ts`.
 *
 * The case that matters most is the EMPTY one. Unset means nobody, which is the
 * opposite of the obvious default and deliberate: getting it backwards hands
 * every workspace a feature that comments on, labels and merges other people's
 * pull requests.
 */

describe('isWorkflowsAllowedEmail', () => {
  beforeEach(() => resetWorkflowsAccessCache());
  afterEach(() => {
    delete process.env.WORKFLOWS_ALLOWED_EMAILS;
    delete process.env.WORKFLOWS_ENABLED;
    resetWorkflowsAccessCache();
  });

  it('an unset list allows nobody', () => {
    expect(workflowsAllowlistIsEmpty()).toBe(true);
    expect(isWorkflowsAllowedEmail('tom@example.com')).toBe(false);
  });

  it.each(['', '   ', ',', ' , , '])('a blank-ish list (%j) allows nobody', (raw) => {
    process.env.WORKFLOWS_ALLOWED_EMAILS = raw;
    resetWorkflowsAccessCache();
    expect(workflowsAllowlistIsEmpty()).toBe(true);
    expect(isWorkflowsAllowedEmail('tom@example.com')).toBe(false);
  });

  it('matches case-insensitively and tolerates whitespace', () => {
    process.env.WORKFLOWS_ALLOWED_EMAILS = ' Tom@Example.com , other@x.com ';
    resetWorkflowsAccessCache();
    expect(isWorkflowsAllowedEmail('tom@example.com')).toBe(true);
    expect(isWorkflowsAllowedEmail('TOM@EXAMPLE.COM')).toBe(true);
    expect(isWorkflowsAllowedEmail('other@x.com')).toBe(true);
    expect(isWorkflowsAllowedEmail('nobody@x.com')).toBe(false);
  });

  it('refuses a null or empty email', () => {
    process.env.WORKFLOWS_ALLOWED_EMAILS = 'tom@example.com';
    resetWorkflowsAccessCache();
    expect(isWorkflowsAllowedEmail(null)).toBe(false);
    expect(isWorkflowsAllowedEmail(undefined)).toBe(false);
    expect(isWorkflowsAllowedEmail('')).toBe(false);
  });

  it('re-reads the env when it changes between cases', () => {
    process.env.WORKFLOWS_ALLOWED_EMAILS = 'a@x.com';
    expect(isWorkflowsAllowedEmail('a@x.com')).toBe(true);
    process.env.WORKFLOWS_ALLOWED_EMAILS = 'b@x.com';
    expect(isWorkflowsAllowedEmail('a@x.com')).toBe(false);
    expect(isWorkflowsAllowedEmail('b@x.com')).toBe(true);
  });
});

describe('workflowsSubsystemEnabled', () => {
  afterEach(() => delete process.env.WORKFLOWS_ENABLED);

  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['1', false],
    ['TRUE', false],
    ['true', true],
  ])('WORKFLOWS_ENABLED=%j → %s', (value, expected) => {
    if (value === undefined) delete process.env.WORKFLOWS_ENABLED;
    else process.env.WORKFLOWS_ENABLED = value;
    expect(workflowsSubsystemEnabled()).toBe(expected);
  });
});

describe('workflowsRefusalReason', () => {
  afterEach(() => {
    delete process.env.WORKFLOWS_ENABLED;
    delete process.env.WORKFLOWS_ALLOWED_EMAILS;
    resetWorkflowsAccessCache();
  });

  it('distinguishes the three reasons — reading one as another costs an evening', () => {
    expect(workflowsRefusalReason()).toMatch(/not enabled on this deployment/);

    process.env.WORKFLOWS_ENABLED = 'true';
    resetWorkflowsAccessCache();
    expect(workflowsRefusalReason()).toMatch(/no allowlist configured/);

    process.env.WORKFLOWS_ALLOWED_EMAILS = 'someone@x.com';
    resetWorkflowsAccessCache();
    expect(workflowsRefusalReason()).toMatch(/not on the workflows allowlist/);
  });
});

describe('workspaceMayUseWorkflows', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.test' });
    await db.insert(workspacesTable).values({
      id: 'ws-1',
      ownerId: TEST_USER_ID,
      name: 'Test',
      settings: {},
    });
    resetWorkflowsAccessCache();
  });

  afterEach(async () => {
    delete process.env.WORKFLOWS_ENABLED;
    delete process.env.WORKFLOWS_ALLOWED_EMAILS;
    resetWorkflowsAccessCache();
    await cleanup();
  });

  it('allows a workspace whose OWNER is on the list', async () => {
    process.env.WORKFLOWS_ENABLED = 'true';
    process.env.WORKFLOWS_ALLOWED_EMAILS = 'tom@example.test';
    resetWorkflowsAccessCache();
    expect(await workspaceMayUseWorkflows('ws-1')).toBe(true);
  });

  it('refuses when the owner is not on the list', async () => {
    process.env.WORKFLOWS_ENABLED = 'true';
    process.env.WORKFLOWS_ALLOWED_EMAILS = 'somebody-else@example.test';
    resetWorkflowsAccessCache();
    expect(await workspaceMayUseWorkflows('ws-1')).toBe(false);
  });

  it('refuses when the subsystem is off, whatever the list says', async () => {
    process.env.WORKFLOWS_ALLOWED_EMAILS = 'tom@example.test';
    resetWorkflowsAccessCache();
    expect(await workspaceMayUseWorkflows('ws-1')).toBe(false);
  });

  it('refuses a workspace that does not exist', async () => {
    process.env.WORKFLOWS_ENABLED = 'true';
    process.env.WORKFLOWS_ALLOWED_EMAILS = 'tom@example.test';
    resetWorkflowsAccessCache();
    expect(await workspaceMayUseWorkflows('ws-nope')).toBe(false);
  });
});
