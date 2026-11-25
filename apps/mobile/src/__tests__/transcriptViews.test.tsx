import type { ToolBlock, Workbench } from '@talyn/shared';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text, View } from 'react-native';

import { TranscriptContext, type TranscriptActions } from '../features/chat/fullTool';
import { RowBoundary } from '../features/chat/RowBoundary';
import { ToolRow } from '../features/chat/ToolRow';
import type { TranscriptRow as Row } from '../features/chat/transcript';
import { sameRowProps, TranscriptRow, type PlanControls, type QuestionControls } from '../features/chat/TranscriptRow';
import { session } from './workflowFixtures';

jest.mock('expo-symbols', () => {
  const native = jest.requireActual('react-native');
  return { SymbolView: ({ name }: { name: { ios: string } }) => <native.View testID={`symbol:${name.ios}`} /> };
});
jest.mock('expo-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('../auth/AuthProvider', () => ({ useMobileRuntime: () => ({ workflow: {} }), useNetwork: () => 'online' }));

const plan: PlanControls = { busy: false, disabled: false, approve: jest.fn(), keepPlanning: jest.fn() };
const question: QuestionControls = { busy: false, disabled: false, waiting: false, answer: jest.fn() };
const workbench = session() as Workbench;
function Bomb(): never { throw new Error('bad row'); }
const tool = (patch: Partial<ToolBlock> = {}): ToolBlock => ({ kind: 'tool', key: '3.0', toolId: 't1', name: 'Bash', input: { command: 'npm test' },
  output: 'first lines', isError: false, stopped: false, settled: true, ...patch });

describe('render errors stay inside one part of the conversation', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());
  it('shows a notice in place of a row that throws and keeps its neighbours', async () => {
    await render(<View>
      <Text>Before</Text>
      <RowBoundary label="This message" resetKey="a"><Bomb /></RowBoundary>
      <Text>After</Text>
    </View>);
    expect(screen.getByText('This message could not be shown.')).toBeVisible();
    expect(screen.getByText('Before')).toBeVisible(); expect(screen.getByText('After')).toBeVisible();
  });
  it('tries again when the row data changes', async () => {
    const view = await render(<RowBoundary label="This message" resetKey="a"><Bomb /></RowBoundary>);
    await view.rerender(<RowBoundary label="This message" resetKey="b"><Text>Fixed</Text></RowBoundary>);
    expect(screen.getByText('Fixed')).toBeVisible();
  });
  it('offers a retry for the whole conversation', async () => {
    let fail = true;
    function Maybe() { if (fail) throw new Error('bad'); return <Text>Conversation</Text>; }
    await render(<RowBoundary label="The conversation" resetKey="chat" retry><Maybe /></RowBoundary>);
    fail = false;
    await fireEvent.press(screen.getByText('Try again'));
    expect(screen.getByText('Conversation')).toBeVisible();
  });
  it.each([
    ['a tool row without its tool', { key: 'k', timestamp: null, kind: 'tool', tool: null, partial: false }],
    ['a user row without text', { key: 'k', timestamp: null, kind: 'user', text: null, attachments: 0, files: null }],
  ])('draws %s as a notice instead of closing the app', async (_name, row) => {
    await render(<TranscriptRow row={row as unknown as Row} now={0} workbench={workbench} plan={plan} question={question} />);
    expect(screen.getByText('This message could not be shown.')).toBeVisible();
  });
  it('draws an unreadable turn as a notice', async () => {
    await render(<TranscriptRow row={{ key: 'k', timestamp: null, kind: 'broken' }} now={0} workbench={workbench} plan={plan} question={question} />);
    expect(screen.getByText('Part of this conversation could not be shown.')).toBeVisible();
  });
});

describe('rows draw again only for what they show', () => {
  const text: Row = { key: 'a', timestamp: null, kind: 'text', text: 'Hi', streaming: false };
  const user: Row = { key: 'u', timestamp: '2026-11-08T11:00:00Z', kind: 'user', text: 'Hi', attachments: 0, files: [] };
  const system: Row = { key: 's', timestamp: null, kind: 'system', text: 'Opened', isError: false };
  const planRow: Row = { key: 'p', timestamp: null, kind: 'plan', plan: 'Do it', state: 'open' };
  const questionRow: Row = { key: 'q', timestamp: null, kind: 'question', question: { id: 'q1', questions: [] }, state: 'open', answeredBy: null };
  const base = { now: 1, workbench, plan, question };
  it.each([
    ['text, clock tick', text, { now: 2 }, true],
    ['text, workbench update', text, { workbench: { ...workbench, title: 'New' } }, true],
    ['user, clock tick', user, { now: 2 }, false],
    ['system, unrelated workbench update', system, { workbench: { ...workbench, title: 'New' } }, true],
    ['system, linked PR change', system, { workbench: { ...workbench, pullRequestId: 'pr-9' } }, false],
    ['plan, new controls', planRow, { plan: { ...plan, busy: true } }, false],
    ['text, plan controls', text, { plan: { ...plan, busy: true } }, true],
    ['question, new controls', questionRow, { question: { ...question, busy: true } }, false],
    ['plan, question controls', planRow, { question: { ...question, busy: true } }, true],
  ])('%s: same is %s', (_name, row, change, same) => {
    expect(sameRowProps({ ...base, row }, { ...base, row, ...change })).toBe(same);
  });
});

describe('a code review card', () => {
  const finding = (id: string, severity: 'blocker' | 'major' | 'minor' | 'nit', patch: Record<string, unknown> = {}) =>
    ({ id, severity, title: `Title ${id}`, summary: `Summary ${id}.`, filePath: `src/${id}.ts`, lineStart: 4, lineEnd: 6, ...patch });
  const base = { reviewId: 'r1', pullRequestId: 'pr-1', prNumber: 12, cycle: 1, headSha: 'abc1234def' };
  const row = (codeReview: unknown, text = 'Code review'): Row => ({ key: 'cr', timestamp: null, kind: 'system', text, subtype: 'talyn_code_review', isError: false,
    codeReview: codeReview as never });
  const show = (codeReview: unknown) => render(<TranscriptRow row={row(codeReview)} now={1} workbench={workbench} plan={plan} question={question} />);
  const finished = (findings: unknown[], findingCount = findings.length) => ({ ...base, action: 'finished', findingCount, findings, sentToAgent: false });

  it('shows a started review with its size', async () => {
    await show({ ...base, action: 'started', fileCount: 1, reviewerCount: 3 });
    expect(screen.getByText('Code review started')).toBeVisible();
    expect(screen.getByText('#12')).toBeVisible();
    expect(screen.getByText('1 changed file · 3 reviewers at abc1234')).toBeVisible();
    expect(screen.queryByText('View findings')).toBeNull();
  });
  it('shows a clean review without a findings link', async () => {
    await show(finished([]));
    expect(screen.getByText('Code review finished with no findings')).toBeVisible();
    expect(screen.queryByText('View findings')).toBeNull();
  });
  it.each([
    ['started', { ...base, action: 'started', fileCount: 1, reviewerCount: 1 }, 'magnifyingglass'],
    ['clean', { ...base, action: 'finished', findingCount: 0, findings: [], sentToAgent: false }, 'checkmark.shield'],
    ['with findings', { ...base, action: 'finished', findingCount: 1, findings: [finding('a', 'nit')], sentToAgent: false }, 'exclamationmark.triangle'],
    ['failed', { ...base, action: 'failed', message: 'x' }, 'exclamationmark.circle'],
    ['stopped', { ...base, action: 'cancelled' }, 'stop.circle'],
  ])('uses the right icon for a %s review', async (_name, event, ios) => {
    await show(event);
    const icons = screen.getAllByTestId(/^symbol:/).map((node) => String(node.props.testID).slice('symbol:'.length));
    expect(icons[0]).toBe(ios);
  });
  it('shows a stopped review', async () => {
    await show({ ...base, action: 'cancelled' });
    expect(screen.getByText('Code review stopped')).toBeVisible();
    expect(screen.getByText('Stopped before it finished at abc1234.')).toBeVisible();
    expect(screen.queryByText('View findings')).toBeNull();
  });
  it('shows a failed review with its message', async () => {
    await show({ ...base, action: 'failed', message: 'Runner crashed' });
    expect(screen.getByText('Code review failed')).toBeVisible();
    expect(screen.getByText('Runner crashed')).toBeVisible();
  });
  it('leaves out the number when Talyn did not know it', async () => {
    await show({ ...base, prNumber: null, action: 'started', fileCount: 0, reviewerCount: 0 });
    expect(screen.queryByText(/^#/)).toBeNull();
    expect(screen.getByText('Reviewing the pull request at abc1234')).toBeVisible();
  });
  it('lists the first three findings, most serious first, with counts and a location', async () => {
    await show(finished([finding('a', 'nit'), finding('b', 'blocker'), finding('c', 'minor'), finding('d', 'major'), finding('e', 'blocker', { filePath: null })]));
    expect(screen.getByText('2 Must fix · 1 Should fix · 1 Consider · 1 Nitpick')).toBeVisible();
    const titles = screen.getAllByText(/^Title /).map((node) => node.props.children);
    expect(titles).toEqual(['Title b', 'Title e', 'Title d']);
    expect(screen.getAllByText('Must fix')).toHaveLength(2);
    expect(screen.getByText('Should fix')).toBeVisible();
    expect(screen.getByText('src/b.ts:4-6')).toBeVisible();
    expect(screen.getByText('Show 2 more')).toBeVisible();
    expect(screen.getByText('View findings')).toBeVisible();
  });
  it('shows all findings and folds them again', async () => {
    await show(finished([finding('a', 'major'), finding('b', 'major'), finding('c', 'major'), finding('d', 'nit')]));
    expect(screen.queryByText('Title d')).toBeNull();
    await fireEvent.press(screen.getByText('Show 1 more'));
    expect(screen.getByText('Title d')).toBeVisible();
    await fireEvent.press(screen.getByText('Show fewer'));
    expect(screen.queryByText('Title d')).toBeNull();
  });
  it('has no toggle for three findings or fewer', async () => {
    await show(finished([finding('a', 'major'), finding('b', 'nit')]));
    expect(screen.queryByText(/^Show /)).toBeNull();
  });
  it('opens a finding summary on a tap', async () => {
    await show(finished([finding('a', 'major')]));
    const summary = screen.getByText('Summary a.');
    expect(summary.props.numberOfLines).toBe(2);
    await fireEvent.press(screen.getByRole('button', { name: /Should fix\. Title a/ }));
    expect(screen.getByText('Summary a.').props.numberOfLines).toBeUndefined();
  });
  it('tells how many findings the snapshot left out', async () => {
    await show(finished([finding('a', 'major')], 25));
    expect(screen.getByText('24 more in the findings list')).toBeVisible();
  });
  it('shows a finding with no summary and no file as a title only', async () => {
    await show(finished([finding('a', 'minor', { summary: '', filePath: null })]));
    expect(screen.getByText('Title a')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Title a/ })).toBeNull();
  });
});

describe('a tool row holding a preview', () => {
  const actions = (load: TranscriptActions['loadFullTool']): TranscriptActions => ({ loadFullTool: load });
  it('loads the whole result on demand and keeps it in the row', async () => {
    const load = jest.fn(async (held: ToolBlock) => ({ ...held, output: 'the whole output' }));
    await render(<TranscriptContext.Provider value={actions(load)}><ToolRow tool={tool()} partial /></TranscriptContext.Provider>);
    await fireEvent.press(screen.getByRole('button', { name: /npm test/ }));
    await act(async () => { fireEvent.press(screen.getByText('Show more')); });
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByText('the whole output')).toBeVisible();
    expect(screen.queryByText('Show more')).toBeNull();
  });
  it.each([
    ['fails', async () => { throw new Error('offline'); }],
    ['finds nothing', async () => null],
  ])('offers a retry when the load %s', async (_name, failure) => {
    const load = jest.fn(failure as TranscriptActions['loadFullTool']);
    await render(<TranscriptContext.Provider value={actions(load)}><ToolRow tool={tool()} partial /></TranscriptContext.Provider>);
    await fireEvent.press(screen.getByRole('button', { name: /npm test/ }));
    await act(async () => { fireEvent.press(screen.getByText('Show more')); });
    expect(screen.getByText('Could not load the whole output. Try again')).toBeVisible();
    load.mockResolvedValueOnce({ ...tool(), output: 'second try' });
    await act(async () => { fireEvent.press(screen.getByText('Could not load the whole output. Try again')); });
    expect(screen.getByText('second try')).toBeVisible();
  });
  it('says it is a preview when no conversation can load the rest', async () => {
    await render(<ToolRow tool={tool()} partial />);
    await fireEvent.press(screen.getByRole('button', { name: /npm test/ }));
    await fireEvent.press(screen.getByText('Show more'));
    expect(screen.getByText('Preview. Open the session on the web for the whole output.')).toBeVisible();
  });
  it('hides edit counts computed from a cut input', async () => {
    const edit = tool({ name: 'Edit', input: { file_path: '/a.ts', old_string: 'a', new_string: 'b' }, output: 'ok' });
    const view = await render(<ToolRow tool={edit} partial />);
    expect(screen.queryByText('+1')).toBeNull();
    await view.rerender(<ToolRow tool={edit} />);
    expect(screen.getByText('+1')).toBeVisible();
  });
});

describe('the question card', () => {
  const DATABASE = { question: 'Which database?', header: 'Database', options: [{ label: 'Postgres', description: 'The default.' }, { label: 'SQLite' }], multiSelect: false };
  const FEATURES = { question: 'Which features?', options: [{ label: 'Search' }, { label: 'Export' }], multiSelect: true };
  const row = (questions: Array<typeof DATABASE | typeof FEATURES>, patch: Partial<Extract<Row, { kind: 'question' }>> = {}): Row =>
    ({ key: 'q', timestamp: null, kind: 'question', question: { id: 'q1', questions }, state: 'open', answeredBy: null, ...patch });
  const controls = (patch: Partial<QuestionControls> = {}): QuestionControls => ({ busy: false, disabled: false, waiting: false, answer: jest.fn(), ...patch });
  const draw = (r: Row, q = controls()) => render(<TranscriptRow row={r} now={0} workbench={workbench} plan={plan} question={q} />);

  it('shows the header, the options with their descriptions and an Other field', async () => {
    await draw(row([DATABASE]));
    expect(screen.getByText('Question')).toBeVisible();
    expect(screen.getByText('Database')).toBeVisible();
    expect(screen.getByText('Which database?')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Postgres. The default.' })).toBeVisible();
    expect(screen.getByText('The default.')).toBeVisible();
    expect(screen.getByLabelText('Other answer 1')).toBeVisible();
  });

  it('sends a single-select answer with one tap when there is one question', async () => {
    const q = controls();
    await draw(row([DATABASE]), q);
    await fireEvent.press(screen.getByRole('button', { name: 'SQLite' }));
    expect(q.answer).toHaveBeenCalledWith('Which database?\n→ SQLite');
    expect(screen.queryByRole('button', { name: 'Send answers' })).toBeNull();
  });

  it('sends the Other answer with its own button', async () => {
    const q = controls();
    await draw(row([DATABASE]), q);
    await fireEvent.changeText(screen.getByLabelText('Other answer 1'), 'MySQL');
    await fireEvent.press(screen.getByRole('button', { name: 'Send answer' }));
    expect(q.answer).toHaveBeenCalledWith('Which database?\n→ MySQL');
  });

  it('needs an answer to every question before it sends', async () => {
    const q = controls();
    await draw(row([DATABASE, FEATURES]), q);
    const send = () => screen.getByRole('button', { name: 'Send answers' });
    expect(send()).toBeDisabled();
    await fireEvent.press(screen.getByRole('radio', { name: 'Postgres. The default.' }));
    expect(q.answer).not.toHaveBeenCalled();
    expect(send()).toBeDisabled();
    await fireEvent.press(screen.getByRole('checkbox', { name: 'Search' }));
    await fireEvent.press(screen.getByRole('checkbox', { name: 'Export' }));
    expect(screen.getByRole('checkbox', { name: 'Export' })).toBeChecked();
    expect(send()).toBeEnabled();
    await fireEvent.press(send());
    expect(q.answer).toHaveBeenCalledWith('Which database?\n→ Postgres\n\nWhich features?\n→ Search, Export');
  });

  it('shows the options read-only while the chat runs', async () => {
    await draw(row([DATABASE]), controls({ waiting: true }));
    expect(screen.getByText('Postgres')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Postgres. The default.' })).toBeNull();
    expect(screen.queryByLabelText('Other answer 1')).toBeNull();
  });

  it.each([
    ['the person', null, 'Answered'],
    ['the thread', { kind: 'thread' as const, threadId: 't1', name: 'Storage plan' }, 'Answered by thread Storage plan'],
  ])('marks a question answered by %s and offers no buttons', async (_name, answeredBy, label) => {
    await draw(row([DATABASE], { state: 'answered', answeredBy }));
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('labels a message the thread wrote', async () => {
    await draw({ key: 'u', timestamp: null, kind: 'user', text: 'Use Postgres', attachments: 0, files: [], sender: { kind: 'thread', threadId: 't1', name: 'Storage plan' } });
    expect(screen.getByText('From thread Storage plan')).toBeVisible();
    expect(screen.getByLabelText('From thread Storage plan: Use Postgres')).toBeVisible();
  });
});
