import { useEffect, useRef, useSyncExternalStore } from 'react';
import { applyAppTheme, languageIdFor, monaco } from '../../lib/monaco';

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
const isDarkTheme = () => document.documentElement.classList.contains('dark');

/** A read-only Monaco editor for one file. Loaded lazily: see FilesTab. */
export default function CodeViewer({ path, content }: { path: string; content: string }) {
  const host = useRef<HTMLDivElement>(null);
  const dark = useSyncExternalStore(subscribeTheme, isDarkTheme);

  useEffect(() => applyAppTheme(dark), [dark]);

  useEffect(() => {
    if (!host.current) return undefined;
    const model = monaco.editor.createModel(content, languageIdFor(path));
    const editor = monaco.editor.create(host.current, {
      model,
      readOnly: true,
      domReadOnly: true,
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      renderLineHighlight: 'none',
      folding: true,
      links: true,
      contextmenu: true,
      stickyScroll: { enabled: true },
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
      fontSize: 12,
      lineHeight: 18,
      lineNumbersMinChars: 3,
      padding: { top: 4, bottom: 4 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, alwaysConsumeMouseWheel: false },
      overviewRulerLanes: 0,
      fixedOverflowWidgets: true,
    });
    return () => {
      editor.dispose();
      model.dispose();
    };
  }, [path, content]);

  return <div ref={host} className="h-full w-full" data-testid="code-viewer" />;
}
