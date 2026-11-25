import type { ToolBlock, ToolGroupBlock } from '@talyn/shared';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { TranscriptContext } from '../features/chat/fullTool';
import { ToolGroupRow, ToolRow } from '../features/chat/ToolRow';

jest.mock('../lib/features', () => ({ useFeatures: jest.fn(() => null) }));
jest.mock('../auth/AuthProvider', () => ({ useMobileRuntime: () => ({ workflow: {} }), useNetwork: () => 'online' }));
jest.mock('expo-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => children }));

const DATA = 'iVBORw0KGgo=';
const whole = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: DATA } }];
const slimOutput = [{ type: 'image', source: { type: 'base64' } }];
const mcpWhole = [{ type: 'image', data: DATA, mimeType: 'image/png' }];

const tool = (patch: Partial<ToolBlock> = {}): ToolBlock => ({ kind: 'tool', key: '1.0', toolId: 'a', name: 'Read',
  input: { file_path: 'shots/a.png' }, output: whole, settled: true, stopped: false, isError: false, ...patch });

describe('tool images', () => {
  it.each([
    ['an Anthropic image', whole],
    ['an MCP image', mcpWhole],
  ])('shows a thumbnail for %s, labelled by the file', async (_name, output) => {
    await render(<ToolRow tool={tool({ output })} />);
    expect(screen.getByRole('imagebutton', { name: 'shots/a.png' })).toBeTruthy();
    expect(screen.queryByText('Show image')).toBeNull();
  });

  it('labels an MCP screenshot by the tool name', async () => {
    await render(<ToolRow tool={tool({ name: 'mcp__browser__screenshot', input: {}, output: mcpWhole })} />);
    expect(screen.getByRole('imagebutton', { name: 'screenshot' })).toBeTruthy();
  });

  it('opens a thumbnail full size', async () => {
    await render(<ToolRow tool={tool()} />);
    await fireEvent.press(screen.getAllByRole('imagebutton')[0]);
    expect(screen.getByRole('button', { name: 'Close image' })).toBeTruthy();
  });

  it('loads a slim image on demand', async () => {
    const load = jest.fn(async (held: ToolBlock) => ({ ...held, output: whole }));
    await render(<TranscriptContext.Provider value={{ loadFullTool: load }}><ToolRow tool={tool({ output: slimOutput })} partial /></TranscriptContext.Provider>);
    expect(screen.queryAllByRole('imagebutton')).toHaveLength(0);
    await act(async () => { await fireEvent.press(screen.getByRole('button', { name: 'Show image' })); });
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('imagebutton')).toHaveLength(1);
    expect(screen.queryByText('Show image')).toBeNull();
  });

  it('offers a count for several images', async () => {
    const load = jest.fn(async () => null);
    await render(<TranscriptContext.Provider value={{ loadFullTool: load }}><ToolRow tool={tool({ output: [...slimOutput, ...slimOutput] })} partial /></TranscriptContext.Provider>);
    expect(screen.getByRole('button', { name: 'Show 2 images' })).toBeTruthy();
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('offline'))],
    ['returns nothing', () => Promise.resolve(null)],
  ])('shows an error and lets the person try again when the load %s', async (_name, loader) => {
    const load = jest.fn(loader as () => Promise<ToolBlock | null>);
    await render(<TranscriptContext.Provider value={{ loadFullTool: load }}><ToolRow tool={tool({ output: slimOutput })} partial /></TranscriptContext.Provider>);
    await act(async () => { await fireEvent.press(screen.getByRole('button', { name: 'Show image' })); });
    expect(screen.getByText('Could not load the image. Try again')).toBeTruthy();
    await act(async () => { await fireEvent.press(screen.getByRole('button', { name: 'Could not load the image. Try again' })); });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shows a caption when there is no loader', async () => {
    await render(<ToolRow tool={tool({ output: slimOutput })} partial />);
    expect(screen.getByText('Image. Open the session on the web to see it.')).toBeTruthy();
  });

  it('shows nothing for a call without images', async () => {
    await render(<ToolRow tool={tool({ output: [{ type: 'text', text: 'hi' }] })} />);
    expect(screen.queryAllByRole('imagebutton')).toHaveLength(0);
  });

  it('shows the images of a closed group, and no copy when it is open', async () => {
    const group: ToolGroupBlock = { kind: 'tool_group', key: 'g', children: [tool({ key: '1.0', toolId: 'a' }), tool({ key: '2.0', toolId: 'b', name: 'Bash', input: { command: 'ls' }, output: 'x' })],
      summary: 'Read a file, ran a command', running: false, isError: false, failedCount: 0, lastFailed: false } as unknown as ToolGroupBlock;
    await render(<ToolGroupRow group={group} />);
    expect(screen.getAllByRole('imagebutton')).toHaveLength(1);
    await fireEvent.press(screen.getByRole('button', { name: /Read a file/ }));
    expect(screen.getAllByRole('imagebutton')).toHaveLength(1);
  });
});
