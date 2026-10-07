import '@testing-library/jest-dom';
import React from 'react';
import { act, render, fireEvent, waitFor, cleanup, screen, within } from '@testing-library/react';
import {
  CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES,
  resolveCodeReviewSettings,
  type CodeReviewFinding,
  type CodeReviewPublic,
  type CodeReviewSettings,
  type SkillSummary,
} from '@talyn/shared';
import { CodeReviewSettingsCard, reviewersBadge } from '../renderer/components/panels/codeReview/CodeReviewSettingsCard';
import {
  ReviewersSettings,
  reviewerSkillRefusal,
} from '../renderer/components/panels/codeReview/ReviewersSettings';
import { FindingsTab, notNeededCount } from '../renderer/components/widgets/codeReview/FindingsTab';
import { api } from '../renderer/lib/api';
import { toast } from '../renderer/stores/toast';
import { trackEvent } from '../renderer/lib/analytics';

/**
 * A team's own reviewers, in Settings and on a finding.
 *
 * The settings block must never offer a change the server refuses, and must
 * send the whole reviewer list in the shape the route stores. A finding must
 * name the skill that raised it, not its key.
 *
 * Duplicated in apps/web on purpose: the renderer is a deliberate fork.
 */

const mockUseSkills = jest.fn();
jest.mock('../renderer/hooks/useSkills', () => ({
  useSkills: (...args: unknown[]) => mockUseSkills(...args),
}));
jest.mock('../renderer/lib/api', () => ({
  api: {
    workspaces: { update: jest.fn() },
    codeReviews: { lenses: jest.fn() },
    pullRequests: {
      codeReview: jest.fn(),
      postCodeReviewFindings: jest.fn(),
      codeReviewFinding: jest.fn(),
    },
  },
}));
const mockStore: Record<string, unknown> = {};
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) => selector(mockStore),
}));
jest.mock('../renderer/stores/billing', () => ({ maybeHandleBillingLimit: jest.fn(() => false) }));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('../renderer/lib/markdown', () => ({
  Markdown: ({ text }: { text: string }) => <span>{text}</span>,
}));
jest.mock('@pierre/diffs/react', () => ({ PatchDiff: () => null }));

const mocked = api as unknown as {
  workspaces: { update: jest.Mock };
  codeReviews: { lenses: jest.Mock };
  pullRequests: { codeReview: jest.Mock };
};

const REPO_KEY = 'repo:acme/api:house-rules';
const PLATFORM_KEY = 'platform:s1';
const REPO_REVIEWER = { skillKey: REPO_KEY, name: 'house-rules' };
const PLATFORM_REVIEWER = { skillKey: PLATFORM_KEY, name: 'Security rules' };

const skills: SkillSummary[] = [
  { key: REPO_KEY, source: 'repo', name: 'house-rules', description: 'Our rules', repositoryId: 'r1' },
  { key: 'repo:acme/api:big', source: 'repo', name: 'big', description: '', repositoryId: 'r1', contentSize: CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES + 1 },
  { key: PLATFORM_KEY, source: 'platform', name: 'Security rules', description: 'Injection', id: 's1' },
  { key: 'local:notes', source: 'local', name: 'notes', description: 'Mine', localPath: '/x/SKILL.md' },
];

function setStore(codeReview: CodeReviewSettings | undefined) {
  Object.assign(mockStore, {
    currentWorkspaceId: 'ws1',
    workspaces: [{ id: 'ws1', name: 'ws', settings: codeReview ? { codeReview } : {} }],
    setWorkspaces: jest.fn(),
    features: { codeReview: true },
    repositories: [
      { id: 'r1', workspaceId: 'ws1', owner: 'acme', repo: 'api', fullName: 'acme/api' },
      { id: 'r2', workspaceId: 'ws1', owner: 'acme', repo: 'web', fullName: 'acme/web' },
      { id: 'r9', workspaceId: 'other', owner: 'x', repo: 'y', fullName: 'x/y' },
    ],
  });
}

const builtInSwitch = () =>
  document.querySelector('[data-attr="settings-code-review-builtin-reviewers"]') as HTMLInputElement;
const addButton = () =>
  document.querySelector('[data-attr="settings-code-review-add-reviewer"]') as HTMLButtonElement;
const reviewerRows = () =>
  [...document.querySelectorAll('[data-attr="settings-code-review-reviewer"]')] as HTMLElement[];
const pickerRow = (name: string) =>
  ([...document.querySelectorAll('[data-attr="reviewer-picker-skill"]')] as HTMLButtonElement[]).find(
    (row) => within(row).queryByText(name)
  )!;

function renderBlock(codeReview: CodeReviewSettings | undefined, disabled = false) {
  const onSave = jest.fn();
  render(
    <ReviewersSettings
      settings={resolveCodeReviewSettings(codeReview)}
      disabled={disabled}
      onSave={onSave}
    />
  );
  return onSave;
}

beforeEach(() => {
  jest.clearAllMocks();
  setStore(undefined);
  mockUseSkills.mockReturnValue({
    skills,
    localFiles: [],
    usage: {},
    repoStatus: 'ok',
    loading: false,
    refreshing: false,
    error: null,
    refresh: jest.fn(),
  });
  mocked.codeReviews.lenses.mockResolvedValue({ lenses: [] });
  mocked.workspaces.update.mockResolvedValue({});
});

afterEach(cleanup);

describe('ReviewersSettings', () => {
  it("shows Talyn's reviewers on, an empty list, and what a reviewer costs", () => {
    renderBlock(undefined);
    expect(builtInSwitch()).toBeChecked();
    expect(screen.getByText(/Logic, Security, Reliability and the others/)).toBeInTheDocument();
    expect(screen.getByText('Your reviewers')).toBeInTheDocument();
    expect(screen.getByText(/None yet\./)).toBeInTheDocument();
    expect(screen.getByText(/Each reviewer is one agent run per review\./)).toBeInTheDocument();
    expect(screen.getByText(/splits it into parts/)).toBeInTheDocument();
  });

  it("will not turn Talyn's reviewers off with no reviewer of your own, and says why", () => {
    const onSave = renderBlock(undefined);
    expect(builtInSwitch()).toBeDisabled();
    expect(screen.getByText('To turn these off, add a reviewer of your own first.')).toBeInTheDocument();
    fireEvent.click(builtInSwitch());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("turns Talyn's reviewers off once there is one of your own", () => {
    const onSave = renderBlock({ customReviewers: [PLATFORM_REVIEWER] });
    expect(builtInSwitch()).toBeEnabled();
    expect(screen.queryByText(/add a reviewer of your own first/)).not.toBeInTheDocument();
    fireEvent.click(builtInSwitch());
    expect(onSave).toHaveBeenCalledWith({ builtInReviewers: false }, "Talyn's reviewers");
  });

  it('turns them back on from off', () => {
    const onSave = renderBlock({ builtInReviewers: false, customReviewers: [PLATFORM_REVIEWER] });
    expect(builtInSwitch()).not.toBeChecked();
    expect(builtInSwitch()).toBeEnabled();
    fireEvent.click(builtInSwitch());
    expect(onSave).toHaveBeenCalledWith({ builtInReviewers: true }, "Talyn's reviewers");
  });

  it('lists each reviewer with its source, and says where a repo skill runs', () => {
    renderBlock({ customReviewers: [REPO_REVIEWER, PLATFORM_REVIEWER] });
    const [repoRow, platformRow] = reviewerRows();
    expect(within(repoRow!).getByText('house-rules')).toBeInTheDocument();
    expect(within(repoRow!).getByText('acme/api')).toBeInTheDocument();
    expect(within(repoRow!).getByText('Runs on pull requests in acme/api only.')).toBeInTheDocument();
    expect(within(platformRow!).getByText('Security rules')).toBeInTheDocument();
    expect(within(platformRow!).getByText('Talyn skill')).toBeInTheDocument();
    expect(within(platformRow!).queryByText(/Runs on pull requests in/)).not.toBeInTheDocument();
  });

  it('removes a reviewer by saving the list without it', () => {
    const onSave = renderBlock({ customReviewers: [REPO_REVIEWER, PLATFORM_REVIEWER] });
    fireEvent.click(screen.getByLabelText('Remove house-rules'));
    expect(onSave).toHaveBeenCalledWith({ customReviewers: [PLATFORM_REVIEWER] }, 'your reviewers');
  });

  it.each<[string, boolean, CodeReviewSettings]>([
    ["the only reviewer, with Talyn's off", true, { builtInReviewers: false, customReviewers: [PLATFORM_REVIEWER] }],
    ["one of two, with Talyn's off", false, { builtInReviewers: false, customReviewers: [REPO_REVIEWER, PLATFORM_REVIEWER] }],
    ["the only reviewer, with Talyn's on", false, { customReviewers: [PLATFORM_REVIEWER] }],
  ])('removing %s: blocked = %s', (_label, blocked, codeReview) => {
    const onSave = renderBlock(codeReview);
    const remove = screen.getByLabelText('Remove Security rules');
    const hint = document.querySelector('[data-attr="reviewers-last-hint"]');
    if (blocked) {
      expect(remove).toBeDisabled();
      expect(hint).toHaveTextContent("Turn on Talyn’s reviewers before you remove it.");
      fireEvent.click(remove);
      expect(onSave).not.toHaveBeenCalled();
    } else {
      expect(remove).toBeEnabled();
      expect(hint).toBeNull();
      fireEvent.click(remove);
      expect(onSave).toHaveBeenCalledTimes(1);
    }
  });

  it('disables every control while a save is in flight', () => {
    renderBlock({ customReviewers: [REPO_REVIEWER, PLATFORM_REVIEWER] }, true);
    expect(builtInSwitch()).toBeDisabled();
    expect(addButton()).toBeDisabled();
    expect(screen.getByLabelText('Remove house-rules')).toBeDisabled();
  });

  describe('adding a reviewer', () => {
    it('opens the picker on the workspace repositories and its skills', () => {
      renderBlock(undefined);
      expect(screen.queryByText('Add a reviewer')).not.toBeInTheDocument();
      fireEvent.click(addButton());

      expect(screen.getByText('Add a reviewer')).toBeInTheDocument();
      // The first repository of THIS workspace, and no other workspace's.
      expect(mockUseSkills).toHaveBeenLastCalledWith('ws1', 'r1');
      const options = within(screen.getByLabelText('Repository')).getAllByRole('option');
      expect(options.map((o) => o.textContent)).toEqual(['acme/api', 'acme/web']);
      expect(screen.getByText('In acme/api')).toBeInTheDocument();
      expect(screen.getByText('On Talyn')).toBeInTheDocument();
    });

    it('reads the skills of the repository that is chosen', () => {
      renderBlock(undefined);
      fireEvent.click(addButton());
      fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'r2' } });
      expect(mockUseSkills).toHaveBeenLastCalledWith('ws1', 'r2');
      expect(screen.getByText('In acme/web')).toBeInTheDocument();
    });

    it('saves the list with the picked skill at the end, and closes', () => {
      const onSave = renderBlock({ customReviewers: [PLATFORM_REVIEWER] });
      fireEvent.click(addButton());
      fireEvent.click(pickerRow('house-rules'));
      expect(onSave).toHaveBeenCalledWith(
        { customReviewers: [PLATFORM_REVIEWER, REPO_REVIEWER] },
        'your reviewers'
      );
      expect(screen.queryByText('Add a reviewer')).not.toBeInTheDocument();
    });

    it.each([
      ['a skill on this machine', 'notes', 'On this machine only. Talyn runs reviews on its servers.'],
      ['a skill that is a reviewer already', 'Security rules', 'Already a reviewer'],
      ['a skill that is too large', 'big', 'Too large to run as a reviewer'],
    ])('shows %s with the reason and does not offer it', (_label, name, reason) => {
      const onSave = renderBlock({ customReviewers: [PLATFORM_REVIEWER] });
      fireEvent.click(addButton());
      const row = pickerRow(name);
      expect(row).toBeDisabled();
      expect(within(row).getByText(reason)).toBeInTheDocument();
      fireEvent.click(row);
      expect(onSave).not.toHaveBeenCalled();
    });

    it('filters by the search box', () => {
      renderBlock(undefined);
      fireEvent.click(addButton());
      fireEvent.change(screen.getByPlaceholderText('Search skills…'), { target: { value: 'inject' } });
      expect(pickerRow('Security rules')).toBeTruthy();
      expect(pickerRow('house-rules')).toBeUndefined();
    });

    it('says so when the repository skills could not be loaded', () => {
      mockUseSkills.mockReturnValue({
        skills: [skills[2]!],
        localFiles: [],
        usage: {},
        repoStatus: 'error',
        repoError: 'rate limited',
        loading: false,
        refresh: jest.fn(),
      });
      renderBlock(undefined);
      fireEvent.click(addButton());
      expect(screen.getByText(/Could not load this repository’s skills: rate limited\./)).toBeInTheDocument();
      // A Talyn skill is still there to choose.
      expect(pickerRow('Security rules')).toBeEnabled();
    });
  });

  it.each<[string, SkillSummary, string | null]>([
    ['a repo skill', skills[0]!, null],
    ['a Talyn skill', { ...skills[2]!, key: 'platform:other' }, null],
    ['a skill at exactly the limit', { ...skills[0]!, contentSize: CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES }, null],
    ['a skill one byte over', { ...skills[0]!, contentSize: CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES + 1 }, 'Too large to run as a reviewer'],
    ['a skill added already', skills[2]!, 'Already a reviewer'],
    ['a local skill', skills[3]!, 'On this machine only. Talyn runs reviews on its servers.'],
  ])('reviewerSkillRefusal: %s', (_label, skill, expected) => {
    expect(reviewerSkillRefusal(skill, [PLATFORM_REVIEWER])).toBe(expected);
  });

  it.each([
    [true, 0, "Talyn's"],
    [true, 2, "Talyn's and 2 of your own"],
    [false, 1, '1 of your own'],
    [false, 0, 'None'],
  ])('reviewersBadge(%s, %i) is %s', (builtIn, custom, expected) => {
    expect(reviewersBadge(builtIn, custom)).toBe(expected);
  });
});

describe('CodeReviewSettingsCard reviewers', () => {
  it('saves a removal as the whole list under settings.codeReview', async () => {
    setStore({ customReviewers: [REPO_REVIEWER, PLATFORM_REVIEWER] });
    render(<CodeReviewSettingsCard />);
    expect(screen.getByText('Who reviews')).toBeInTheDocument();
    expect(screen.getByText("Talyn's and 2 of your own")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Remove house-rules'));

    await waitFor(() => expect(mocked.workspaces.update).toHaveBeenCalledTimes(1));
    expect(mocked.workspaces.update).toHaveBeenCalledWith('ws1', {
      settings: { codeReview: { customReviewers: [PLATFORM_REVIEWER] } },
    });
    // The store keeps the other code review settings and takes the new list.
    await waitFor(() => expect(mockStore.setWorkspaces).toHaveBeenCalled());
    const next = (mockStore.setWorkspaces as jest.Mock).mock.calls[0]![0] as {
      settings: { codeReview: CodeReviewSettings };
    }[];
    expect(next[0]!.settings.codeReview.customReviewers).toEqual([PLATFORM_REVIEWER]);
  });

  it('saves an added reviewer, and sends analytics a count and no skill', async () => {
    setStore({ preset: 'deep', customReviewers: [PLATFORM_REVIEWER] });
    render(<CodeReviewSettingsCard />);

    fireEvent.click(addButton());
    fireEvent.click(pickerRow('house-rules'));

    await waitFor(() =>
      expect(mocked.workspaces.update).toHaveBeenCalledWith('ws1', {
        settings: { codeReview: { customReviewers: [PLATFORM_REVIEWER, REPO_REVIEWER] } },
      })
    );
    await waitFor(() => expect(trackEvent).toHaveBeenCalled());
    expect(trackEvent).toHaveBeenCalledWith('code_review_settings_changed', {
      keys: 'customReviewers',
      custom_reviewers: 2,
    });
    expect(JSON.stringify((trackEvent as jest.Mock).mock.calls)).not.toContain('acme');
  });

  it("saves the switch as one key, so the list is not resent", async () => {
    setStore({ customReviewers: [PLATFORM_REVIEWER] });
    render(<CodeReviewSettingsCard />);
    fireEvent.click(builtInSwitch());
    await waitFor(() =>
      expect(mocked.workspaces.update).toHaveBeenCalledWith('ws1', {
        settings: { codeReview: { builtInReviewers: false } },
      })
    );
  });

  it('shows a refusal from the server and leaves the list as it was', async () => {
    setStore({ customReviewers: [PLATFORM_REVIEWER] });
    mocked.workspaces.update.mockRejectedValue(
      new Error('"rules" is a skill in other/secret, which is not a repository of this workspace.')
    );
    render(<CodeReviewSettingsCard />);

    fireEvent.click(addButton());
    fireEvent.click(pickerRow('house-rules'));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Could not change your reviewers',
        '"rules" is a skill in other/secret, which is not a repository of this workspace.'
      )
    );
    expect(mockStore.setWorkspaces).not.toHaveBeenCalled();
    expect(reviewerRows()).toHaveLength(1);
  });

  it('names a custom reviewer in the history of how each reviewer has done', async () => {
    setStore({ customReviewers: [PLATFORM_REVIEWER] });
    mocked.codeReviews.lenses.mockResolvedValue({
      lenses: [
        { lens: 'correctness', raised: 4, kept: 2 },
        { lens: `skill:${PLATFORM_KEY}`, raised: 3, kept: 3 },
        // Removed from the settings since. Its key still says its name.
        { lens: 'skill:repo:acme/api:old-rules', raised: 1, kept: 0 },
      ],
    });
    render(<CodeReviewSettingsCard />);
    await waitFor(() => expect(screen.getByText('3 of 3 kept')).toBeInTheDocument());
    expect(screen.getByText('Logic')).toBeInTheDocument();
    expect(screen.getByText('old-rules')).toBeInTheDocument();
    // Once in the reviewer list and once in the history.
    expect(screen.getAllByText('Security rules')).toHaveLength(2);
  });
});

describe('FindingsTab with a custom reviewer', () => {
  const LENS = `skill:${PLATFORM_KEY}`;

  function review(over: Partial<CodeReviewPublic> = {}): CodeReviewPublic {
    return {
      id: 'rev-1',
      preset: 'standard',
      phase: 'ready',
      phasePlan: [],
      runsDone: 6,
      runsTotal: 6,
      lensesRun: ['correctness', 'security', 'reliability', LENS],
      customReviewers: [{ lensKey: LENS, name: 'Security rules' }],
      chunkTotal: 1,
      headSha: 'a'.repeat(40),
      headShaShort: 'aaaaaaa',
      reviewedHeadSha: 'a'.repeat(40),
      staleForHead: false,
      counts: { blocker: 0, major: 1, minor: 0, nit: 0 },
      openCount: 1,
      dismissedCount: 0,
      funnel: { raised: 0, kept: 0, rejected: 0 },
      failureReason: null,
      deferredSince: null,
      fixTaskId: null,
      lastFix: null,
      startedAt: null,
      finishedAt: null,
      ...over,
    } as CodeReviewPublic;
  }

  function finding(over: Partial<CodeReviewFinding> = {}): CodeReviewFinding {
    return {
      id: 'f-1',
      severity: 'major',
      category: '',
      lenses: ['correctness', LENS],
      filePath: 'src/a.ts',
      lineStart: 10,
      lineEnd: 10,
      anchorVerified: true,
      title: 'Finding f-1',
      confidence: 80,
      verdict: 'confirmed',
      disposition: 'open',
      carriedOver: false,
      seenCount: 1,
      postedAt: null,
      ...over,
    };
  }

  async function renderTab(reviewOver: Partial<CodeReviewPublic> = {}, findingOver: Partial<CodeReviewFinding> = {}) {
    mocked.pullRequests.codeReview.mockResolvedValue({
      review: review(reviewOver),
      findings: [finding(findingOver)],
      defaultPreset: 'standard',
      pullRequest: { owner: 'acme', repo: 'app', number: 7 },
    });
    render(<FindingsTab pullRequestId="pr1" />);
    await waitFor(() => expect(screen.getByText('Finding f-1')).toBeInTheDocument());
    await act(async () => {});
  }

  it('names the skill among the reviewers that read the change', async () => {
    await renderTab();
    expect(screen.getByText(/read by Logic, Security, Reliability, Security rules/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(LENS);
    // All three of Talyn's ran. The extra reviewer is not a missing one.
    expect(document.body.textContent).not.toContain('not needed here');
  });

  it('names the skill on a finding it agrees with', async () => {
    await renderTab();
    expect(screen.getByText(/Logic and Security rules agree/)).toBeInTheDocument();
  });

  it('falls back to what the key says when the review carries no names', async () => {
    await renderTab(
      { customReviewers: undefined, lensesRun: ['correctness', 'skill:repo:acme/api:house-rules'] },
      { lenses: ['correctness', 'skill:repo:acme/api:house-rules'] }
    );
    expect(screen.getByText(/Logic and house-rules agree/)).toBeInTheDocument();
  });

  it.each<[string, string[], 'quick' | 'standard' | 'deep', number]>([
    ["all of Talyn's", ['correctness', 'security', 'reliability'], 'standard', 0],
    ["all of Talyn's and one of the team's", ['correctness', 'security', 'reliability', LENS], 'standard', 0],
    ["one of Talyn's sat out, hidden by nothing", ['correctness', 'security', LENS], 'standard', 1],
    ["two sat out on a docs change", ['correctness', LENS], 'standard', 2],
    ["Talyn's turned off", [LENS], 'standard', 0],
    ["Talyn's turned off, two of the team's", [LENS, 'skill:platform:s2'], 'deep', 0],
    ['nothing ran', [], 'standard', 0],
    ['more custom reviewers than the depth has lenses', ['correctness', LENS, 'skill:platform:s2'], 'quick', 0],
  ])('notNeededCount with %s', (_label, lensesRun, preset, expected) => {
    expect(notNeededCount({ lensesRun, preset })).toBe(expected);
  });

  it("says a lens sat out even when one of the team's reviewers ran", async () => {
    await renderTab({ lensesRun: ['correctness', LENS] });
    expect(screen.getByText(/read by Logic, Security rules \(2 not needed here\)/)).toBeInTheDocument();
  });
});
