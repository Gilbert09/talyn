import { useEffect, useState, useSyncExternalStore } from 'react';
import { FileText, Folder, FolderOpen } from 'lucide-react';
import { loadFileIconResolver, type FileIconResolver } from '../../lib/fileIcons';
import { fileIconUrl } from '../../lib/fileIconUrl';

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
const isLightTheme = () => !document.documentElement.classList.contains('dark');

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

const SIZE = 'h-4 w-4 shrink-0';

/** The Material Icon Theme icon for a file or folder name, with the generic icon until it loads. */
export function FileIcon({ name, folder = false, open = false }: { name: string; folder?: boolean; open?: boolean }) {
  const loaded = useResolver();
  const light = useSyncExternalStore(subscribeTheme, isLightTheme);
  const [failed, setFailed] = useState<string | null>(null);
  const iconName = loaded ? (folder ? loaded.folder(name, open, light) : loaded.file(name, light)) : null;

  if (iconName && iconName !== failed) {
    return (
      <img
        src={fileIconUrl(iconName)}
        alt=""
        className={SIZE}
        loading="lazy"
        draggable={false}
        onError={() => setFailed(iconName)}
      />
    );
  }
  const Fallback = folder ? (open ? FolderOpen : Folder) : FileText;
  return <Fallback className={`${SIZE} text-muted-foreground`} />;
}
