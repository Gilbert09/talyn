import { createRoot } from 'react-dom/client';
// Bundled brand fonts (offline) — body Inter, display Space Grotesk, mono JetBrains.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { captureAnalyticsException, initAnalytics } from './lib/analytics';
import { installNavigation } from './stores/navigation';

// Initialise PostHog before first render so session replay + autocapture
// cover the whole session. No-op unless a key was baked in at build time.
initAnalytics();
const reportMainError = (frame: { source: 'main' | 'renderer'; operation: string; reason?: string; exitCode?: number; errorCode?: string }) => {
  const safeError = new Error(`${frame.source} process failure: ${frame.operation}`);
  safeError.stack = undefined;
  captureAnalyticsException(safeError, {
    source: frame.source,
    operation: frame.operation,
    reason: frame.reason,
    exit_code: frame.exitCode,
    error_code: frame.errorCode,
  });
};
window.electron?.mainErrors?.onEvent(reportMainError);
void window.electron?.mainErrors?.drain().then((frames) => frames.forEach(reportMainError));
installNavigation();

const container = document.getElementById('root') as HTMLElement;
const root = createRoot(container);
root.render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
