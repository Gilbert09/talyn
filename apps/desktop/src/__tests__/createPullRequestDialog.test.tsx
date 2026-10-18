import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WorkbenchChat, WorkbenchPrDraft } from '@talyn/shared';
import { CreatePullRequestDialog } from '../renderer/components/workbench/CreatePullRequestDialog';
import { toast } from '../renderer/stores/toast';
import { useWorkbenchStore } from '../renderer/stores/workbenches';

jest.mock('../renderer/lib/api', () => ({ api: {} }));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const DRAFT: WorkbenchPrDraft = { title: 'feat: add a thing', body: '## Summary\nAdds a thing.', commitMessage: 'feat: add the thing' };
const chat = { id: 'c1', agentSessionId: 's1' } as WorkbenchChat;
const WB = { branch: 'lisbon', baseBranch: 'main' };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(draft = deferred<WorkbenchPrDraft>()) {
  const ops = {
    draftPullRequest: jest.fn(() => draft.promise),
    createPullRequest: jest.fn(),
  };
  const onClose = jest.fn();
  render(<CreatePullRequestDialog workbench={WB} chat={chat} ops={ops} open onClose={onClose} />);
  return { ops, onClose, draft };
}

const field = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('CreatePullRequestDialog', () => {
  it('starts a draft for the chat and the base branch, and says so while it waits', () => {
    const { ops } = setup();
    expect(ops.draftPullRequest).toHaveBeenCalledWith(chat, 'main');
    expect(screen.getAllByText('Writing a description…').length).toBeGreaterThan(0);
    expect(field('Base branch').value).toBe('main');
  });

  it('fills empty fields when the draft lands', async () => {
    const { draft } = setup();
    await act(async () => draft.resolve(DRAFT));
    expect(field('Title').value).toBe(DRAFT.title);
    expect(field('Description').value).toBe(DRAFT.body);
  });

  it.each([
    ['title', 'Title', 'fix: my own title', 'Description', DRAFT.body],
    ['description', 'Description', 'My own words', 'Title', DRAFT.title],
  ])('does not overwrite a %s the user typed before the draft landed', async (_n, typed, value, other, otherValue) => {
    const { draft } = setup();
    fireEvent.change(field(typed), { target: { value } });
    await act(async () => draft.resolve(DRAFT));
    expect(field(typed).value).toBe(value);
    expect(field(other).value).toBe(otherValue);
  });

  it('shows why the draft failed and lets the user write the fields by hand', async () => {
    const { draft, ops } = setup();
    await act(async () => draft.reject(new Error('Claude is not signed in.')));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not write a draft: Claude is not signed in.');
    fireEvent.change(field('Title'), { target: { value: 'chore: by hand' } });
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
    ops.createPullRequest.mockResolvedValue({ workbench: { id: 'wb1' }, pullRequest: { number: 7, url: 'u' }, existing: false });
    jest.spyOn(useWorkbenchStore.getState(), 'upsertWorkbench').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(ops.createPullRequest).toHaveBeenCalled());
    expect(ops.createPullRequest.mock.calls[0][0]).toMatchObject({ title: 'chore: by hand', commitMessage: '' });
  });

  it('Regenerate asks again and may replace what is there', async () => {
    const first = deferred<WorkbenchPrDraft>();
    const { ops } = setup(first);
    fireEvent.change(field('Title'), { target: { value: 'mine' } });
    await act(async () => first.resolve(DRAFT));
    expect(field('Title').value).toBe('mine');
    const second = deferred<WorkbenchPrDraft>();
    ops.draftPullRequest.mockImplementation(() => second.promise);
    fireEvent.click(screen.getByRole('button', { name: /Regenerate/ }));
    expect(ops.draftPullRequest).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve({ ...DRAFT, title: 'feat: second go' }));
    expect(field('Title').value).toBe('feat: second go');
  });

  it('Create sends the fields, the draft flag and the drafted commit message, then closes', async () => {
    const { draft, ops, onClose } = setup();
    await act(async () => draft.resolve(DRAFT));
    fireEvent.change(field('Base branch'), { target: { value: 'develop' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Create as draft' }));
    const upsert = jest.spyOn(useWorkbenchStore.getState(), 'upsertWorkbench').mockImplementation(() => {});
    const workbench = { id: 'wb1' };
    ops.createPullRequest.mockResolvedValue({ workbench, pullRequest: { number: 42, url: 'https://github.com/acme/app/pull/42' }, existing: false });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ops.createPullRequest).toHaveBeenCalledWith({
      title: DRAFT.title,
      body: DRAFT.body,
      base: 'develop',
      draft: true,
      commitMessage: DRAFT.commitMessage,
    });
    expect(upsert).toHaveBeenCalledWith(workbench);
    expect(toast.success).toHaveBeenCalledWith('Opened #42', 'https://github.com/acme/app/pull/42');
  });

  it('keeps the dialog open and shows the error when Create fails', async () => {
    const { draft, ops, onClose } = setup();
    await act(async () => draft.resolve(DRAFT));
    ops.createPullRequest.mockRejectedValue(
      new Error('GitHub refused the push. The Talyn GitHub App needs Contents: Read & write on acme/app.'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Contents: Read & write on acme/app'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Create waits for a title', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });
});
