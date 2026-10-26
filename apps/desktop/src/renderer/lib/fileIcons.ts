export interface FileIconMaps {
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folderNames: Record<string, string>;
  /** Only the folders whose open icon is not `<closed>-open`. */
  folderNamesOpen: Record<string, string>;
}

export interface FileIconData extends FileIconMaps {
  file: string;
  folder: string;
  folderOpen: string;
  light: FileIconMaps;
}

export interface FileIconResolver {
  file(name: string, light: boolean): string;
  folder(name: string, open: boolean, light: boolean): string;
}

const has = (map: Record<string, string>, key: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;

/** Resolves like VS Code: exact name, then the longest extension, then the default. */
export function createFileIconResolver(data: FileIconData): FileIconResolver {
  const lookupFile = (maps: FileIconMaps, lower: string): string | undefined => {
    const byName = has(maps.fileNames, lower);
    if (byName) return byName;
    for (let dot = lower.indexOf('.'); dot !== -1; dot = lower.indexOf('.', dot + 1)) {
      const byExt = has(maps.fileExtensions, lower.slice(dot + 1));
      if (byExt) return byExt;
    }
    return undefined;
  };

  return {
    file(name, light) {
      const lower = name.toLowerCase();
      const found = (light ? lookupFile(data.light, lower) : undefined) ?? lookupFile(data, lower);
      if (found) return found;
      // .env.local, .env.production and friends
      if (lower.startsWith('.env.')) return has(data.fileNames, '.env') ?? data.file;
      return data.file;
    },
    folder(name, open, light) {
      const lower = name.toLowerCase();
      const pick = (maps: FileIconMaps): string | undefined => {
        const closed = has(maps.folderNames, lower);
        if (!closed) return undefined;
        return open ? (has(maps.folderNamesOpen, lower) ?? `${closed}-open`) : closed;
      };
      return (light ? pick(data.light) : undefined) ?? pick(data) ?? (open ? data.folderOpen : data.folder);
    },
  };
}

let pending: Promise<FileIconResolver> | null = null;

/** The lookup tables are a separate chunk, fetched the first time a file row needs them. */
export function loadFileIconResolver(): Promise<FileIconResolver> {
  pending ??= import('./fileIconData.json').then((m) => createFileIconResolver(m.default as FileIconData));
  return pending;
}
