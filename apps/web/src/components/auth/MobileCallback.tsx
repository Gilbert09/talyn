import { useLayoutEffect } from 'react';

export function MobileCallback() {
  useLayoutEffect(() => {
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.hash);
  }, []);

  return (
    <div className="flex h-screen items-center justify-center p-6">
      <div className="max-w-md text-center">
        <h1 className="font-medium">Return to the Talyn app</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This page finishes signing in to the Talyn mobile app. Open Talyn on your phone to continue. If you are on a computer, sign in to the web app instead.
        </p>
        <a className="mt-4 inline-block text-sm underline" href="/">
          Open the Talyn web app
        </a>
      </div>
    </div>
  );
}
