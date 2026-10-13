export type Emit = (channel: string, payload: unknown) => void;

export function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

export async function stopGroup(pid: number): Promise<void> {
  if (!signalGroup(pid, 'SIGTERM')) return;
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      try {
        if (Date.now() - started >= 5000) {
          signalGroup(pid, 'SIGKILL');
          clearInterval(timer);
          resolve();
        } else if (!signalGroup(pid, 0)) {
          clearInterval(timer);
          resolve();
        }
      } catch (error) {
        clearInterval(timer);
        reject(error);
      }
    }, 50);
  });
}
