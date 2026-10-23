/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import { ChangesTab } from '../renderer/components/workbench/ChangesTab';
import { FilesTab } from '../renderer/components/workbench/FilesTab';
import { sandboxOps } from '../renderer/lib/workbenchOps';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));

it('shows the recovery message in Changes and Files without polling the lost box', () => {
  const workbench = {
    id: 'wb-lost', runtime: 'sandbox', status: 'provisioning', sandboxState: 'lost',
    statusMessage: 'The sandbox was lost. Talyn is starting a new one.',
  } as Workbench;
  const ops = sandboxOps(workbench);
  const changes = jest.spyOn(ops, 'changes');
  const files = jest.spyOn(ops, 'listFiles');
  render(<>
    <ChangesTab workbench={workbench} chat={null} ops={ops} visible turnsEnded={0} comments={[]} setComments={() => undefined} />
    <FilesTab workbench={workbench} ops={ops} visible />
  </>);
  expect(screen.getAllByText('The sandbox was lost. Talyn is starting a new one.')).toHaveLength(2);
  expect(screen.queryByText(/Talyn Fleet refused/)).not.toBeInTheDocument();
  expect(changes).not.toHaveBeenCalled();
  expect(files).not.toHaveBeenCalled();
});
