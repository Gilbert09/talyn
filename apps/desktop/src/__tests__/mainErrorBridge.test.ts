import { drainMainErrors, markRendererUnavailable, reportMainFailure, setMainErrorSender } from '../main/mainErrorBridge';

it('buffers a renderer crash until the new renderer drains it', () => {
  const send = jest.fn(() => true);
  setMainErrorSender(send);
  markRendererUnavailable();
  reportMainFailure('render_process_gone', undefined, { source: 'renderer', reason: 'crashed', exitCode: 9 });
  expect(send).not.toHaveBeenCalled();
  expect(drainMainErrors()).toEqual([{ source: 'renderer', operation: 'render_process_gone', reason: 'crashed', exitCode: 9, errorCode: undefined }]);
  reportMainFailure('workbench_terminal_open', Object.assign(new Error('secret path'), { code: 'EIO' }));
  expect(send).toHaveBeenCalledWith({ source: 'main', operation: 'workbench_terminal_open', reason: undefined, exitCode: undefined, errorCode: 'EIO' });
});
