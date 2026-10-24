import { parseToml } from './toml.js';

export type PreviewTarget = 'sandbox' | 'coder' | 'off';

export interface PreviewPort {
  port: number;
  label?: string;
  primary?: boolean;
}

export interface PreviewCoderConfig {
  url?: string;
  template?: string;
  checkout?: string;
  run?: string;
}

export interface PreviewConfig {
  target?: PreviewTarget;
  ports?: PreviewPort[];
  coder?: PreviewCoderConfig;
}


const recordOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const validPort = (port: unknown): port is number =>
  typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535;

export function parsePreviewConfig(value: unknown, report: (message: string) => void): PreviewConfig | undefined {
  const preview = recordOf(value);
  if (!preview) return undefined;
  const config: PreviewConfig = {};
  if (preview.target !== undefined) {
    if (preview.target === 'sandbox' || preview.target === 'coder' || preview.target === 'off') {
      config.target = preview.target;
    } else {
      report(`[preview] unknown target ${JSON.stringify(preview.target)}`);
    }
  }

  const labels = recordOf(preview.labels) ?? {};
  if (preview.ports !== undefined) {
    config.ports = [];
    if (!Array.isArray(preview.ports)) {
      report('[preview] ports must be an array');
    } else {
      for (const [index, entry] of preview.ports.entries()) {
        const inline = recordOf(entry);
        const port = inline ? inline.port : entry;
        if (!validPort(port)) {
          report(`[preview] invalid port at ports[${index}]: ${JSON.stringify(entry)}`);
          continue;
        }
        const label = inline && typeof inline.label === 'string' ? inline.label : labels[String(port)];
        const item: PreviewPort = { port };
        if (typeof label === 'string') item.label = label;
        if (inline ? inline.primary === true : config.ports.length === 0) item.primary = true;
        config.ports.push(item);
      }
    }
  }

  const coder = recordOf(preview.coder);
  if (coder) {
    config.coder = {};
    for (const key of ['url', 'template', 'checkout', 'run'] as const) {
      if (typeof coder[key] !== 'string') continue;
      if (key === 'url' && !/^https?:\/\//i.test(coder.url as string)) {
        report(`[preview.coder] url must start with http:// or https://`);
        continue;
      }
      config.coder[key] = coder[key] as string;
    }
  }
  return config;
}

export interface DetectedPreview {
  target: PreviewTarget | null;
  ports: PreviewPort[];
  coder?: { url?: string; template?: string; reason: string };
  coderHint?: string;
  reasons: string[];
}

export const PREVIEW_DETECT_PATHS: string[] = [
  '.talyn/settings.toml',
  'hogli.yaml',
  'package.json',
  'docker-compose.yml',
  'docker-compose.yaml',
  'docker-compose.dev.yml',
  'compose.yml',
  'compose.yaml',
  '.devcontainer/devcontainer.json',
  'devcontainer.json',
  'Procfile',
  'mprocs.yaml',
  'bin/mprocs.yaml',
  'main.tf',
];

const INFRA_PORTS = new Set([
  2181, 3306, 5432, 5672, 6379, 6380, 7233, 8123, 9000, 9009,
  9092, 9093, 9200, 9300, 11211, 15672, 27017,
]);

function stripJsonComments(source: string): string {
  let result = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      result += char;
      if (char === '\\') result += source[++i] ?? '';
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      result += char;
    } else if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      result += '\n';
    } else if (char === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i++;
    } else {
      result += char;
    }
  }
  return result;
}

function commandPort(command: string): number | null {
  const match = command.match(/(?:^|\s)(?:--port(?:=|\s+)|-p\s+|PORT=)(\d+)\b/);
  return match ? Number(match[1]) : null;
}

function composePorts(source: string): number[] {
  const ports: number[] = [];
  let portsIndent: number | null = null;
  for (const line of source.split(/\r?\n/)) {
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (portsIndent !== null && line.trim() && !line.trim().startsWith('#') && indent <= portsIndent) {
      portsIndent = null;
    }
    if (/^\s*ports:\s*(?:#.*)?$/.test(line)) {
      portsIndent = indent;
      continue;
    }
    if (portsIndent === null) continue;
    const match = line.match(/^\s*-\s*["']?(?:(?:\d{1,3}\.){3}\d{1,3}:)?(\d+):(\d+)(?:\/(?:tcp|udp))?["']?(?:\s|$)/);
    if (match) ports.push(Number(match[1]));
  }
  return ports;
}

export function detectPreview(input: { files: Record<string, string | null>; paths: string[] }): DetectedPreview {
  const { files, paths } = input;
  const reasons: string[] = [];
  const result: DetectedPreview = { target: null, ports: [], reasons };
  let config: PreviewConfig | undefined;
  const talyn = files['.talyn/settings.toml'];
  if (talyn) {
    try {
      config = parsePreviewConfig(parseToml(talyn).preview, () => undefined);
    } catch {
      // A broken settings file supplies no preview signals.
    }
  }

  if (config?.coder) {
    const reason = 'Found [preview.coder] in .talyn/settings.toml.';
    result.coder = {
      ...(config.coder.url ? { url: config.coder.url } : {}),
      ...(config.coder.template ? { template: config.coder.template } : {}),
      reason,
    };
    reasons.push(reason);
  } else {
    const hogli = files['hogli.yaml'];
    const coderUrl = hogli?.match(/^\s*coder_url:\s*(["']?)([^\s#"']+)\1\s*(?:#.*)?$/m)?.[2];
    if (coderUrl) {
      const reason = 'Found coder_url in hogli.yaml.';
      result.coder = { url: coderUrl, reason };
      reasons.push(reason);
    } else if (paths.some((path) => /(^|\/)\.coder(?:\/|$)/.test(path))) {
      const reason = 'Found a .coder directory.';
      result.coder = { reason };
      reasons.push(reason);
    } else {
      const terraform = Object.entries(files).find(([path, contents]) =>
        path.endsWith('.tf') && contents && /\b(?:provider\s+"coder"|resource\s+"coder_(?:app|agent)")/.test(contents));
      if (terraform) {
        const reason = `Found a Coder resource in ${terraform[0]}.`;
        result.coder = { reason };
        reasons.push(reason);
      }
    }
  }
  const hint = paths.find((path) => /(^|\/)docs?\/.*coder.*\.md$/i.test(path));
  if (hint) {
    result.coderHint = `Found a Coder document at ${hint}.`;
    reasons.push(result.coderHint);
  }

  const seen = new Set<number>();
  const addPort = (port: unknown, reason: string, label?: string) => {
    if (!validPort(port) || seen.has(port) || result.ports.length >= 8) return;
    seen.add(port);
    result.ports.push({ port, ...(label ? { label } : {}), ...(result.ports.length === 0 ? { primary: true } : {}) });
    reasons.push(reason);
  };
  for (const entry of config?.ports ?? []) {
    addPort(entry.port, `Found port ${entry.port} in .talyn/settings.toml.`, entry.label);
  }
  for (const path of ['.devcontainer/devcontainer.json', 'devcontainer.json']) {
    const source = files[path];
    if (!source) continue;
    try {
      const doc = recordOf(JSON.parse(stripJsonComments(source)));
      for (const entry of Array.isArray(doc?.forwardPorts) ? doc.forwardPorts : []) {
        const port = typeof entry === 'number' ? entry : typeof entry === 'string' ? Number(entry.split(':').at(-1)) : NaN;
        addPort(port, `Found port ${port} in ${path}.`);
      }
    } catch {
      // An invalid devcontainer file supplies no ports.
    }
  }
  const packageSource = files['package.json'];
  if (packageSource) {
    try {
      const scripts = recordOf(recordOf(JSON.parse(packageSource))?.scripts);
      const command = typeof scripts?.dev === 'string' ? scripts.dev : scripts?.start;
      if (typeof command === 'string') {
        const override = commandPort(command);
        const defaultPort = /\bvite\b/.test(command) ? 5173
          : /\b(?:next|react-scripts|nuxt|remix)\b/.test(command) ? 3000
          : /\bastro\b/.test(command) ? 4321
          : /\bsvelte-kit\b/.test(command) ? 5173 : null;
        addPort(override ?? defaultPort, 'Found a development port in package.json.');
      }
    } catch {
      // An invalid package file supplies no ports.
    }
  }
  for (const path of ['docker-compose.yml', 'docker-compose.yaml', 'docker-compose.dev.yml', 'compose.yml', 'compose.yaml']) {
    const source = files[path];
    if (!source) continue;
    for (const port of composePorts(source)) {
      if (!INFRA_PORTS.has(port)) addPort(port, `Found published port ${port} in ${path}.`);
    }
  }
  const procfile = files.Procfile;
  const web = procfile?.match(/^web:\s*(.+)$/m)?.[1];
  if (web) {
    const port = commandPort(web) ?? Number(web.match(/:(\d+)\b/)?.[1]);
    addPort(port, 'Found a web port in Procfile.');
  }
  for (const path of ['mprocs.yaml', 'bin/mprocs.yaml']) {
    const source = files[path];
    if (!source) continue;
    for (const match of source.matchAll(/--port(?:=|\s+)(\d+)\b/g)) {
      addPort(Number(match[1]), `Found port ${match[1]} in ${path}.`);
    }
  }

  if (config?.target) {
    result.target = config.target;
    reasons.push(`Found preview target ${config.target} in .talyn/settings.toml.`);
  } else {
    result.target = result.coder ? 'coder' : result.ports.length ? 'sandbox' : null;
  }
  return result;
}
