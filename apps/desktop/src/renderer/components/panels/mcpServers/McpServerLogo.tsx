import { MCP_CATALOG } from '@talyn/shared';
import { Plug } from 'lucide-react';

export function McpServerLogo({ url, catalogHandle }: { url?: string | null; catalogHandle?: string | null }) {
  let entry = MCP_CATALOG.find((item) => item.handle === catalogHandle);
  if (!entry && url) {
    try {
      const address = new URL(url);
      if (address.protocol === 'https:') {
        entry = MCP_CATALOG.find((item) => new URL(item.url).hostname === address.hostname);
      }
    } catch {
      // An invalid address uses the generic icon.
    }
  }
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white p-1">
      {entry ? (
        <img src={entry.logo} alt="" width={24} height={24} className="object-contain" />
      ) : (
        <Plug className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
      )}
    </span>
  );
}
