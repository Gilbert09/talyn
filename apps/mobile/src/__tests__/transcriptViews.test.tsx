import type { ToolBlock, Workbench } from '@talyn/shared';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text, View } from 'react-native';

import { TranscriptContext, type TranscriptActions } from '../features/chat/fullTool';
import { RowBoundary } from '../features/chat/RowBoundary';
import { ToolRow } from '../features/chat/ToolRow';
import type { TranscriptRow as Row } from '../features/chat/transcript';
import { sameRowProps, TranscriptRow, type PlanControls } from '../features/chat/TranscriptRow';
import { session } from './workflowFixtures';

jest.mock('expo-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('../auth/AuthProvider', () => ({ useMobileRuntime: () => ({ workflow: {} }), useNetwork: () => 'online' }));

const plan: PlanControls = { busy: false, disabled: false, approve: jest.fn(), keepPlanning: jest.fn() };
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
    await render(<TranscriptRow row={row as unknown as Row} now={0} workbench={workbench} plan={plan} />);
    expect(screen.getByText('This message could not be shown.')).toBeVisible();
  });
  it('draws an unreadable turn as a notice', async () => {
    await render(<TranscriptRow row={{ key: 'k', timestamp: null, kind: 'broken' }} now={0} workbench={workbench} plan={plan} />);
    expect(screen.getByText('Part of this conversation could not be shown.')).toBeVisible();
  });
});

describe('rows draw again only for what they show', () => {
  const text: Row = { key: 'a', timestamp: null, kind: 'text', text: 'Hi', streaming: false };
  const user: Row = { key: 'u', timestamp: '2026-11-08T11:00:00Z', kind: 'user', text: 'Hi', attachments: 0, files: [] };
  const system: Row = { key: 's', timestamp: null, kind: 'system', text: 'Opened', isError: false };
  const planRow: Row = { key: 'p', timestamp: null, kind: 'plan', plan: 'Do it', state: 'open' };
  const base = { now: 1, workbench, plan };
  it.each([
    ['text, clock tick', text, { now: 2 }, true],
    ['text, workbench update', text, { workbench: { ...workbench, title: 'New' } }, true],
    ['user, clock tick', user, { now: 2 }, false],
    ['system, unrelated workbench update', system, { workbench: { ...workbench, title: 'New' } }, true],
    ['system, linked PR change', system, { workbench: { ...workbench, pullRequestId: 'pr-9' } }, false],
    ['plan, new controls', planRow, { plan: { ...plan, busy: true } }, false],
    ['text, plan controls', text, { plan: { ...plan, busy: true } }, true],
  ])('%s: same is %s', (_name, row, change, same) => {
    expect(sameRowProps({ ...base, row }, { ...base, row, ...change })).toBe(same);
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
