import { WORKBENCH_MOVING_MESSAGE, type Workbench } from '@talyn/shared';
import { describe, expect, it } from 'vitest';
import { sandboxWaitText } from '../Composer';

describe('sandboxWaitText', () => {
  it.each<[Workbench['status'], string | null, string | null]>([
    ['provisioning', null, 'Waiting for the sandbox to start…'],
    ['provisioning', '', 'Waiting for the sandbox to start…'],
    ['provisioning', '   ', 'Waiting for the sandbox to start…'],
    ['provisioning', '  Running the setup script…  ', 'Waiting for the sandbox to start: Running the setup script'],
    ['provisioning', 'Creating the sandbox.', 'Waiting for the sandbox to start: Creating the sandbox'],
    ['moving', null, WORKBENCH_MOVING_MESSAGE],
    ['moving', '', WORKBENCH_MOVING_MESSAGE],
    ['moving', '   ', WORKBENCH_MOVING_MESSAGE],
    ['moving', '  Copying files…  ', 'Waiting for the sandbox: Copying files'],
    ['moving', 'Copying files.', 'Waiting for the sandbox: Copying files'],
    ['ready', 'Running the setup script', null],
    ['error', 'Running the setup script', null],
    ['archived', 'Running the setup script', null],
    ['archiveError', 'Running the setup script', null],
  ])('%s with %j returns %j', (status, statusMessage, expected) => {
    expect(sandboxWaitText({ status, statusMessage } as Workbench)).toBe(expected);
  });
});
