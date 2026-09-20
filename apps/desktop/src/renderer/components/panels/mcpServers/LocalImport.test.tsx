import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LocalImport } from './LocalImport';

jest.mock('./McpServerLogo', () => ({ McpServerLogo: () => null }));

it('opens once, scans on demand, and imports from the modal', async () => {
  localStorage.clear();
  const scanLocal = jest.fn().mockResolvedValue([]);
  Object.defineProperty(window, 'electron', { configurable: true, value: { mcp: { scanLocal } } });
  const onImport = jest.fn();
  const props = { connectedUrls: new Set<string>(), onImport };
  const first = render(<LocalImport {...props} />);
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(localStorage.getItem('talyn:mcp-local-import-seen')).toBe('1');
  await screen.findByText('No servers found in your Claude or Codex configuration.');
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  first.unmount();

  render(<LocalImport {...props} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  // Twice, not once: one scan per MOUNT. The count on the button
  // ("show available imports on the import button") needs the findings before
  // anybody opens anything, so a mount scans whether or not the modal shows.
  // This assertion predates that badge and was really checking the second
  // mount does not auto-open — which the line above already says.
  expect(scanLocal).toHaveBeenCalledTimes(2);
  scanLocal.mockResolvedValue([{ name: 'example', url: 'https://example.com/mcp', source: 'Claude Code', importable: true }]);
  fireEvent.click(screen.getByRole('button', { name: /Import servers/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Import' }));
  expect(onImport).toHaveBeenCalledWith(expect.objectContaining({ name: 'example', url: 'https://example.com/mcp' }));
  expect(screen.queryByRole('dialog')).toBeNull();

  scanLocal.mockRejectedValue(new Error('scan failed'));
  fireEvent.click(screen.getByRole('button', { name: /Import servers/ }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});
