import { afterEach, describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentEvent } from '@talyn/shared';
import { AgentBlocks } from '../components/workbench/AgentBlocks';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let seq = 0;
const call = (id: string, name: string, input: unknown): AgentEvent =>
  ({ seq: ++seq, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }) as unknown as AgentEvent;
const result = (id: string, content: unknown): AgentEvent =>
  ({ seq: ++seq, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } }) as unknown as AgentEvent;
const readImage = (id: string, path: string) => [
  call(id, 'Read', { file_path: path }),
  result(id, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]),
];

afterEach(cleanup);

describe('tool images in the transcript', () => {
  it('shows an image that the agent opened, without the base64 text', () => {
    render(<AgentBlocks events={readImage('t1', '/tmp/shot.png')} />);
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', `data:image/png;base64,${PNG}`);
    expect(img).toHaveAttribute('alt', '/tmp/shot.png');
    expect(document.body.textContent).not.toContain(PNG);
  });

  it('shows a screenshot from an MCP tool next to its text', () => {
    render(<AgentBlocks events={[
      call('t1', 'mcp__playwright__browser_take_screenshot', {}),
      result('t1', [{ type: 'text', text: 'Took the screenshot' }, { type: 'image', data: PNG, mimeType: 'image/jpeg' }]),
    ]} />);
    expect(screen.getByRole('img')).toHaveAttribute('src', `data:image/jpeg;base64,${PNG}`);
    expect(screen.getByText('Took the screenshot')).toBeInTheDocument();
  });

  it('shows the images of a closed tool group, and each call shows its own when open', () => {
    render(<AgentBlocks events={[
      call('t0', 'Bash', { command: 'npx playwright screenshot' }),
      result('t0', 'ok'),
      ...readImage('t1', '/tmp/one.png'),
      ...readImage('t2', '/tmp/two.png'),
    ]} />);
    const group = screen.getByRole('button', { expanded: false });
    expect(screen.getAllByRole('img').map((img) => img.getAttribute('alt'))).toEqual(['/tmp/one.png', '/tmp/two.png']);
    fireEvent.click(group);
    expect(screen.getAllByRole('img')).toHaveLength(2);
  });

  it('opens the image full size with a download link', () => {
    render(<AgentBlocks events={readImage('t1', '/tmp/shot.png')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open image: /tmp/shot.png' }));
    const download = screen.getByRole('link', { name: 'Download' });
    expect(download).toHaveAttribute('download', 'shot.png');
    expect(screen.queryByRole('link', { name: 'Open original' })).not.toBeInTheDocument();
  });

  it('shows no image for a tool call without one', () => {
    render(<AgentBlocks events={[call('t1', 'Bash', { command: 'ls' }), result('t1', 'a.png')]} />);
    expect(screen.queryByTestId('tool-images')).not.toBeInTheDocument();
  });
});
