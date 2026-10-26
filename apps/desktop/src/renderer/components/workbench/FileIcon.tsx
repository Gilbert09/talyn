import { useEffect, useState, useSyncExternalStore } from 'react';
import { FileText, Folder, FolderOpen } from 'lucide-react';
import { loadFileIconResolver, type FileIconResolver } from '../../lib/fileIcons';
import { loadFileIconUrl } from '../../lib/fileIconUrl';

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
const isLightTheme = () => !document.documentElement.classList.contains('dark');

const resolvedUrls = new Map<string, string>();
let resolver: FileIconResolver | null = null;

function useResolver(): FileIconResolver | null {
  const [value, setValue] = useState(resolver);
  useEffect(() => {
    if (resolver) return;
    let cancelled = false;
    loadFileIconResolver()
      .then((r) => {
        resolver = r;
        if (!cancelled) setValue(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return value;
}

function useIconUrl(iconName: string | null): string | null {
  const [url, setUrl] = useState<string | null>(iconName ? (resolvedUrls.get(iconName) ?? null) : null);
  useEffect(() => {
    if (!iconName) {
      setUrl(null);
      return;
    }
    const cached = resolvedUrls.get(iconName);
    if (cached) {
      setUrl(cached);
      return;
    }
    setUrl(null);
    let cancelled = false;
    loadFileIconUrl(iconName).then((u) => {
      if (u) resolvedUrls.set(iconName, u);
      if (!cancelled) setUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [iconName]);
  return url;
}

const SIZE = 'h-4 w-4 shrink-0';

/** The Material Icon Theme icon for a file or folder name, with the generic icon until it loads. */
export function FileIcon({ name, folder = false, open = false }: { name: string; folder?: boolean; open?: boolean }) {
  const loaded = useResolver();
  const light = useSyncExternalStore(subscribeTheme, isLightTheme);
  const iconName = loaded ? (folder ? loaded.folder(name, open, light) : loaded.file(name, light)) : null;
  const url = useIconUrl(iconName);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (url && url !== failedUrl) {
    return <img src={url} alt="" className={SIZE} draggable={false} onError={() => setFailedUrl(url)} />;
  }
  const Fallback = folder ? (open ? FolderOpen : Folder) : FileText;
  return <Fallback className={`${SIZE} text-muted-foreground`} />;
}
