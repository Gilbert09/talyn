import { useEffect } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { sessionAppUrl } from '@talyn/shared';

const APP_OPEN_TIMEOUT_MS = 1_500;
const openDesktopApp = (url: string) => window.location.assign(url);

export function OpenSession({ openApp = openDesktopApp }: { openApp?: (url: string) => void }) {
  const { id } = useParams();
  const navigate = useNavigate();

  useEffect(() => {
    if (!id) return;
    const browserPath = `/s/${encodeURIComponent(id)}`;
    const timer = window.setTimeout(() => navigate(browserPath, { replace: true }), APP_OPEN_TIMEOUT_MS);
    const stopFallback = () => {
      if (document.hidden) window.clearTimeout(timer);
    };
    document.addEventListener('visibilitychange', stopFallback);
    try {
      openApp(sessionAppUrl(id));
    } catch {
      window.clearTimeout(timer);
      navigate(browserPath, { replace: true });
    }
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', stopFallback);
    };
  }, [id, navigate, openApp]);

  if (!id) return <Navigate to="/" replace />;
  const browserPath = `/s/${encodeURIComponent(id)}`;
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-center">
      <div>
        <h1 className="font-display text-xl font-semibold">Talyn is opening.</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          If the desktop app does not open,{' '}
          <a className="text-primary underline" href={browserPath}>open this session in your browser</a>.
        </p>
      </div>
    </main>
  );
}
