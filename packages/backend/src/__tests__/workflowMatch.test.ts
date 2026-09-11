import { describe, it, expect } from 'vitest';
import {
  actorMatches,
  loginLooksLikeBot,
  renderWorkflowComment,
  workflowMatches,
  type WorkflowConditions,
  type WorkflowEventFacts,
  type WorkflowTriggerEvent,
} from '@talyn/shared';

/**
 * The matcher — the one definition of "this workflow applies to this event",
 * shared by the engine and both editors.
 *
 * The cases that matter most are the NEGATIVE ones: a rule that matches too
 * widely comments on somebody else's PR, and a condition on a fact the payload
 * never carried must fail rather than pass.
 */

function facts(over: Partial<WorkflowEventFacts> = {}): WorkflowEventFacts {
  return {
    event: 'pr_opened',
    repoFullName: 'acme/widget',
    number: 42,
    title: 'Add a widget',
    url: 'https://github.com/acme/widget/pull/42',
    author: { login: 'alice', isBot: false },
    actor: { login: 'alice', isBot: false },
    baseBranch: 'main',
    defaultBranch: 'main',
    headBranch: 'alice/widget',
    draft: false,
    labels: ['enhancement', 'frontend'],
    ...over,
  };
}

function wf(
  conditions: WorkflowConditions = {},
  events: WorkflowTriggerEvent[] = ['pr_opened']
): { events: WorkflowTriggerEvent[]; conditions: WorkflowConditions } {
  return { events, conditions };
}

describe('loginLooksLikeBot', () => {
  it.each([
    ['dependabot[bot]', undefined, true],
    ['talyn-app[bot]', undefined, true],
    ['alice', 'Bot', true],
    ['alice', 'User', false],
    ['alice', undefined, false],
    ['ROBOT[BOT]', undefined, true],
  ])('%s (type %s) → %s', (login, type, expected) => {
    expect(loginLooksLikeBot(login, type as string | undefined)).toBe(expected);
  });
});

describe('actorMatches', () => {
  const human = { login: 'alice', isBot: false };
  const bot = { login: 'dependabot[bot]', isBot: true };

  it('an absent or "any" condition matches everything, including nobody', () => {
    expect(actorMatches(undefined, human)).toBe(true);
    expect(actorMatches({ kind: 'any' }, undefined)).toBe(true);
  });

  it('human only', () => {
    expect(actorMatches({ kind: 'human' }, human)).toBe(true);
    expect(actorMatches({ kind: 'human' }, bot)).toBe(false);
  });

  it('bot only', () => {
    expect(actorMatches({ kind: 'bot' }, bot)).toBe(true);
    expect(actorMatches({ kind: 'bot' }, human)).toBe(false);
  });

  it('exact logins, case-insensitively', () => {
    expect(actorMatches({ kind: 'logins', logins: ['Alice', 'bob'] }, human)).toBe(true);
    expect(actorMatches({ kind: 'logins', logins: ['bob'] }, human)).toBe(false);
  });

  it('viewer matches only the connected user, and only when it is known', () => {
    expect(actorMatches({ kind: 'viewer' }, human, 'alice')).toBe(true);
    expect(actorMatches({ kind: 'viewer' }, human, 'ALICE')).toBe(true);
    expect(actorMatches({ kind: 'viewer' }, human, 'bob')).toBe(false);
    expect(actorMatches({ kind: 'viewer' }, human, null)).toBe(false);
    expect(actorMatches({ kind: 'viewer' }, human)).toBe(false);
  });

  it('a named class or login cannot be satisfied by nobody', () => {
    for (const kind of ['human', 'bot'] as const) {
      expect(actorMatches({ kind }, undefined)).toBe(false);
    }
    expect(actorMatches({ kind: 'logins', logins: ['alice'] }, undefined)).toBe(false);
  });
});

describe('workflowMatches — the event itself', () => {
  it('requires the event to be one the workflow triggers on', () => {
    expect(workflowMatches(wf({}, ['pr_opened']), facts({ event: 'pr_opened' }))).toBe(true);
    expect(workflowMatches(wf({}, ['pr_merged']), facts({ event: 'pr_opened' }))).toBe(false);
  });

  it('a workflow with no conditions matches every PR in the watched repos', () => {
    expect(workflowMatches(wf(), facts())).toBe(true);
  });
});

describe('workflowMatches — conditions', () => {
  it.each<[string, WorkflowConditions, boolean]>([
    ['repo matches', { repos: ['acme/widget'] }, true],
    ['repo matches case-insensitively', { repos: ['ACME/Widget'] }, true],
    ['repo does not match', { repos: ['acme/other'] }, false],
    ['one of several repos matches', { repos: ['acme/other', 'acme/widget'] }, true],
    ['base branch matches', { baseBranches: ['main'] }, true],
    ['base branch does not match', { baseBranches: ['master'] }, false],
    ['title substring matches', { titleContains: 'widget' }, true],
    ['title substring is case-insensitive', { titleContains: 'WIDGET' }, true],
    ['title substring does not match', { titleContains: 'gadget' }, false],
    ['draft:false matches a non-draft', { draft: false }, true],
    ['draft:true does not match a non-draft', { draft: true }, false],
    ['labelsAny matches one', { labelsAny: ['frontend', 'backend'] }, true],
    ['labelsAny matches none', { labelsAny: ['backend'] }, false],
    ['labelsAll matches both', { labelsAll: ['enhancement', 'frontend'] }, true],
    ['labelsAll misses one', { labelsAll: ['enhancement', 'backend'] }, false],
    ['labelsNone excludes', { labelsNone: ['frontend'] }, false],
    ['labelsNone permits', { labelsNone: ['wip'] }, true],
    ['author human matches', { author: { kind: 'human' } }, true],
    ['author bot does not', { author: { kind: 'bot' } }, false],
    ['author login matches', { author: { kind: 'logins', logins: ['alice'] } }, true],
  ])('%s', (_name, conditions, expected) => {
    expect(workflowMatches(wf(conditions), facts())).toBe(expected);
  });

  it('ANDs every condition together', () => {
    const all: WorkflowConditions = {
      repos: ['acme/widget'],
      baseBranches: ['main'],
      titleContains: 'widget',
      labelsAny: ['frontend'],
      author: { kind: 'human' },
    };
    expect(workflowMatches(wf(all), facts())).toBe(true);
    expect(workflowMatches(wf({ ...all, titleContains: 'nope' }), facts())).toBe(false);
  });

  it('tests the actor separately from the author', () => {
    const botActor = facts({ actor: { login: 'dependabot[bot]', isBot: true } });
    expect(workflowMatches(wf({ actor: { kind: 'bot' } }), botActor)).toBe(true);
    expect(workflowMatches(wf({ author: { kind: 'bot' } }), botActor)).toBe(false);
  });
});

describe('workflowMatches — baseIsDefault (the stacked-PR condition)', () => {
  const stacked = facts({ baseBranch: 'alice/part-1', defaultBranch: 'main' });

  it('false matches a PR stacked on another branch', () => {
    expect(workflowMatches(wf({ baseIsDefault: false }), stacked)).toBe(true);
    expect(workflowMatches(wf({ baseIsDefault: false }), facts())).toBe(false);
  });

  it('true matches a PR targeting the default branch', () => {
    expect(workflowMatches(wf({ baseIsDefault: true }), facts())).toBe(true);
    expect(workflowMatches(wf({ baseIsDefault: true }), stacked)).toBe(false);
  });

  it('works for a repo whose default is not "main"', () => {
    // The whole reason this reads the repository's own default rather than
    // comparing against a hardcoded name.
    const posthog = facts({ baseBranch: 'master', defaultBranch: 'master' });
    expect(workflowMatches(wf({ baseIsDefault: true }), posthog)).toBe(true);
    expect(workflowMatches(wf({ baseIsDefault: false }), posthog)).toBe(false);
  });

  it('fails rather than guessing when either branch is unknown', () => {
    const noBase = facts({ baseBranch: '', unknownFields: ['baseBranch'] });
    const noDefault = facts({ defaultBranch: '', unknownFields: ['defaultBranch'] });
    for (const value of [true, false]) {
      expect(workflowMatches(wf({ baseIsDefault: value }), noBase)).toBe(false);
      expect(workflowMatches(wf({ baseIsDefault: value }), noDefault)).toBe(false);
    }
    // Blank without being declared unknown must fail too — comparing '' to ''
    // would otherwise answer "yes, it targets the default branch".
    expect(
      workflowMatches(wf({ baseIsDefault: true }), facts({ baseBranch: '', defaultBranch: '' }))
    ).toBe(false);
  });

  it('composes with an explicit base-branch list', () => {
    // "not the default branch, and not one of these release branches either".
    const rule = wf({ baseIsDefault: false, baseBranches: ['alice/part-1'] });
    expect(workflowMatches(rule, stacked)).toBe(true);
    expect(workflowMatches(rule, facts({ baseBranch: 'release/2', defaultBranch: 'main' }))).toBe(
      false
    );
  });
});

describe('workflowMatches — event-specific conditions', () => {
  it('reviewStates', () => {
    const review = facts({ event: 'pr_review_submitted', reviewState: 'changes_requested' });
    const w = (states: Array<'approved' | 'changes_requested' | 'commented'>) =>
      wf({ reviewStates: states }, ['pr_review_submitted']);
    expect(workflowMatches(w(['changes_requested']), review)).toBe(true);
    expect(workflowMatches(w(['approved']), review)).toBe(false);
    // No verdict on the facts at all cannot satisfy a verdict condition.
    expect(
      workflowMatches(w(['approved']), facts({ event: 'pr_review_submitted' }))
    ).toBe(false);
  });

  it('labelName, exactly and case-insensitively', () => {
    const labeled = facts({ event: 'pr_labeled', labelName: 'Needs-Review' });
    const w = (name: string) => wf({ labelName: name }, ['pr_labeled']);
    expect(workflowMatches(w('needs-review'), labeled)).toBe(true);
    expect(workflowMatches(w('needs'), labeled)).toBe(false);
  });

  it('a viewer target needs BOTH a target and a known viewer', () => {
    const requested = facts({
      event: 'pr_review_requested',
      target: { login: 'tom', isBot: false },
    });
    const w = wf({ target: { kind: 'viewer' } }, ['pr_review_requested']);
    expect(workflowMatches(w, requested, 'tom')).toBe(true);
    expect(workflowMatches(w, requested, 'Tom')).toBe(true);
    expect(workflowMatches(w, requested, 'alice')).toBe(false);
    // An unresolved viewer FAILS — "when I am asked" must not widen into "when
    // anyone is asked" because we could not work out who "I" is.
    expect(workflowMatches(w, requested, null)).toBe(false);
    // An event that named nobody cannot satisfy it.
    expect(workflowMatches(w, facts({ event: 'pr_review_requested' }), 'tom')).toBe(false);
  });

  it('targets a specific person, which is not only "me"', () => {
    const requested = facts({
      event: 'pr_review_requested',
      target: { login: 'carol', isBot: false },
    });
    const w = (logins: string[]) =>
      wf({ target: { kind: 'logins', logins } }, ['pr_review_requested']);
    expect(workflowMatches(w(['carol', 'dave']), requested)).toBe(true);
    expect(workflowMatches(w(['dave']), requested)).toBe(false);
  });

  it('targets a TEAM by slug', () => {
    const teamRequest = facts({
      event: 'pr_review_requested',
      target: { login: 'frontend', isBot: false, teamSlugs: ['frontend'] },
    });
    const w = (teams: string[]) =>
      wf({ target: { kind: 'logins', logins: [], teams } }, ['pr_review_requested']);
    expect(workflowMatches(w(['frontend']), teamRequest)).toBe(true);
    expect(workflowMatches(w(['platform']), teamRequest)).toBe(false);
    // A per-login target is NOT satisfied by a team request — resolving a team's
    // members would be a GitHub call per delivery.
    expect(
      workflowMatches(
        wf({ target: { kind: 'logins', logins: ['tom'] } }, ['pr_review_requested']),
        teamRequest,
        'tom'
      )
    ).toBe(false);
    expect(
      workflowMatches(
        wf({ target: { kind: 'viewer' } }, ['pr_review_requested']),
        teamRequest,
        'tom'
      )
    ).toBe(false);
  });

  it('a viewer match works on the author too — "my own PRs"', () => {
    const mine = facts({ author: { login: 'tom', isBot: false } });
    const w = wf({ author: { kind: 'viewer' } });
    expect(workflowMatches(w, mine, 'tom')).toBe(true);
    expect(workflowMatches(w, facts(), 'tom')).toBe(false);
    expect(workflowMatches(w, mine, null)).toBe(false);
  });

  it('checkConclusions', () => {
    const failed = facts({ event: 'pr_checks_completed', checkConclusion: 'failure' });
    expect(
      workflowMatches(wf({ checkConclusions: ['failure'] }, ['pr_checks_completed']), failed)
    ).toBe(true);
    expect(
      workflowMatches(wf({ checkConclusions: ['success'] }, ['pr_checks_completed']), failed)
    ).toBe(false);
  });

  it('bodyContains', () => {
    const commented = facts({ event: 'pr_comment', body: 'Please rebase this' });
    expect(workflowMatches(wf({ bodyContains: 'rebase' }, ['pr_comment']), commented)).toBe(true);
    expect(workflowMatches(wf({ bodyContains: 'revert' }, ['pr_comment']), commented)).toBe(false);
  });
});

describe('workflowMatches — a condition on a fact the payload never carried', () => {
  // An `issue_comment` payload describes an issue: no base branch, no head
  // branch, no draft flag. A condition on one of those must FAIL, or a rule the
  // user wrote as narrow silently becomes wide.
  const comment = facts({
    event: 'pr_comment',
    baseBranch: '',
    draft: false,
    unknownFields: ['baseBranch', 'headBranch', 'draft'],
  });

  it('fails a baseBranches condition rather than matching the empty default', () => {
    expect(workflowMatches(wf({ baseBranches: ['main'] }, ['pr_comment']), comment)).toBe(false);
    // A list of nothing but blanks is not a constraint — it normalises away, so
    // the workflow is unconstrained and matches. (The validator strips these
    // before they can ever be stored.)
    expect(workflowMatches(wf({ baseBranches: [''] }, ['pr_comment']), comment)).toBe(true);
  });

  it('fails a draft condition rather than matching the false default', () => {
    expect(workflowMatches(wf({ draft: false }, ['pr_comment']), comment)).toBe(false);
    expect(workflowMatches(wf({ draft: true }, ['pr_comment']), comment)).toBe(false);
  });

  it('still matches a condition on a fact the payload DID carry', () => {
    expect(workflowMatches(wf({ titleContains: 'widget' }, ['pr_comment']), comment)).toBe(true);
    expect(workflowMatches(wf({ labelsAny: ['frontend'] }, ['pr_comment']), comment)).toBe(true);
  });

  it('fails a label condition when labels are unknown (a check_suite payload)', () => {
    const checks = facts({
      event: 'pr_checks_completed',
      labels: [],
      title: '',
      author: { login: '', isBot: false },
      unknownFields: ['title', 'url', 'author', 'draft', 'labels'],
    });
    expect(workflowMatches(wf({ labelsAny: ['frontend'] }, ['pr_checks_completed']), checks)).toBe(false);
    expect(workflowMatches(wf({ labelsNone: ['wip'] }, ['pr_checks_completed']), checks)).toBe(false);
    expect(workflowMatches(wf({ titleContains: 'x' }, ['pr_checks_completed']), checks)).toBe(false);
    expect(workflowMatches(wf({ author: { kind: 'human' } }, ['pr_checks_completed']), checks)).toBe(false);
    // But an unconstrained workflow still fires — that is the whole point of
    // "checks finished" as a trigger.
    expect(workflowMatches(wf({}, ['pr_checks_completed']), checks)).toBe(true);
  });
});

describe('renderWorkflowComment', () => {
  it('interpolates the PR facts', () => {
    expect(
      renderWorkflowComment('Thanks {{pr.author}} — {{repo}}#{{pr.number}} targets {{pr.baseBranch}}', facts())
    ).toBe('Thanks alice — acme/widget#42 targets main');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(renderWorkflowComment('{{ pr.number }}', facts())).toBe('42');
  });

  it('leaves an unknown placeholder VERBATIM rather than blanking it', () => {
    // A comment that posts `{{pr.reviewer}}` tells the user their template is
    // wrong. An empty string hides the mistake in a comment on a real PR.
    expect(renderWorkflowComment('ping {{pr.reviewer}}', facts())).toBe('ping {{pr.reviewer}}');
  });
});
