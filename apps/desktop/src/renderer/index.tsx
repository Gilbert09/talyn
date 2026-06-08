import { createRoot } from 'react-dom/client';
import App from './App';
import { initAnalytics } from './lib/analytics';

// Initialise PostHog before first render so session replay + autocapture
// cover the whole session. No-op unless a key was baked in at build time.
initAnalytics();

const container = document.getElementById('root') as HTMLElement;
const root = createRoot(container);
root.render(<App />);

// calling IPC exposed from preload script
window.electron?.ipcRenderer.once('ipc-example', (arg) => {
  // eslint-disable-next-line no-console
  console.log(arg);
});
window.electron?.ipcRenderer.sendMessage('ipc-example', ['ping']);
