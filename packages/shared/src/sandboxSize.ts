/** The ordered sizes supply resources and labels to the backend and both apps. */
export const SANDBOX_SIZES = {
  small: { memMib: 2048, milliVcpu: 2000, label: 'Small · 2 GB', hint: 'Docs and scripts' },
  standard: { memMib: 4096, milliVcpu: 4000, label: 'Standard · 4 GB', hint: 'Most repos' },
  medium: { memMib: 8192, milliVcpu: 4000, label: 'Medium · 8 GB', hint: 'Big builds, one database' },
  large: { memMib: 12288, milliVcpu: 6000, label: 'Large · 12 GB', hint: 'Full test stacks' },
  xlarge: { memMib: 16384, milliVcpu: 8000, label: 'X-Large · 16 GB', hint: 'The heaviest stacks' },
} as const;

export type SandboxSize = keyof typeof SANDBOX_SIZES;
export type SandboxSizeSetting = 'auto' | SandboxSize;

export const SANDBOX_SIZE_SETTINGS: readonly SandboxSizeSetting[] = ['auto', ...(Object.keys(SANDBOX_SIZES) as SandboxSize[])];

export function isSandboxSizeSetting(value: unknown): value is SandboxSizeSetting {
  return typeof value === 'string' && (SANDBOX_SIZE_SETTINGS as readonly string[]).includes(value);
}

export interface DetectedSandboxSize {
  size: SandboxSize;
  reason: string;
}

export interface CachedSandboxSize extends DetectedSandboxSize {
  sha: string;
  at: string;
}

export interface RepositorySandboxSizeResponse {
  setting: SandboxSizeSetting;
  detected: CachedSandboxSize | null;
  /** What a new session gets today: the setting, else the detected size, else standard. */
  effective: SandboxSize;
}

/** Resolution order: the person's choice, then detection, then standard. */
export function resolveSandboxSize(setting: SandboxSizeSetting | undefined, detected: SandboxSize | null | undefined): SandboxSize {
  if (setting && setting !== 'auto' && Object.hasOwn(SANDBOX_SIZES, setting)) return setting;
  return detected ?? 'standard';
}

/** The most compose files read per repository, so a detection costs a bounded number of GitHub reads. */
export const MAX_COMPOSE_FILES = 6;

export function isComposeFileName(name: string): boolean {
  return /^(docker-)?compose([.-][\w.-]+)?\.ya?ml$/i.test(name);
}

const DATABASES = /(postgres|postgis|timescale|mysql|mariadb|mongo|cockroach|cassandra|scylla|clickhouse|mssql|sqlserver|oracle|couchbase|neo4j)/i;
const HEAVY = /(clickhouse|kafka|redpanda|zookeeper|elasticsearch|opensearch|temporal|cassandra|scylla|mssql|sqlserver|oracle|neo4j|couchbase)/i;

interface ComposeService {
  name: string;
  image: string;
}

/** A light reader for the `services:` map of a compose file. It needs no YAML library. */
export function parseComposeServices(content: string): ComposeService[] {
  const services: ComposeService[] = [];
  let inServices = false;
  let childIndent = -1;
  let current: ComposeService | null = null;
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inServices = /^services:\s*$/.test(line);
      childIndent = -1;
      current = null;
      continue;
    }
    if (!inServices) continue;
    if (childIndent === -1) childIndent = indent;
    if (indent === childIndent) {
      const match = line.trim().match(/^["']?([\w.-]+)["']?:\s*$/);
      current = match ? { name: match[1], image: '' } : null;
      if (current) services.push(current);
    } else if (current && indent > childIndent) {
      const image = line.trim().match(/^image:\s*["']?([^\s"']+)/);
      if (image) current.image = image[1];
    }
  }
  return services;
}

/**
 * Decide whether a repository's local stack needs the large sandbox, from its
 * compose files. A heavy service (ClickHouse, Kafka, Zookeeper, Elasticsearch
 * and the like) means large. So do three or more services that include a
 * database. A cache such as Redis is not a database.
 */
export function detectSandboxSize(files: { path: string; content: string | null }[]): DetectedSandboxSize {
  const heavy = new Map<string, string>();
  let busiest: { path: string; count: number; database: string } | null = null;
  let scanned = 0;
  for (const file of files) {
    if (!file.content) continue;
    const services = parseComposeServices(file.content);
    if (!services.length) continue;
    scanned++;
    for (const service of services) {
      const probe = `${service.image} ${service.name}`;
      const hit = probe.match(HEAVY);
      if (hit && !heavy.has(hit[1].toLowerCase())) heavy.set(hit[1].toLowerCase(), file.path);
    }
    const database = services.find((s) => DATABASES.test(`${s.image} ${s.name}`));
    if (database && services.length >= 3 && (!busiest || services.length > busiest.count)) {
      busiest = { path: file.path, count: services.length, database: database.name };
    }
  }
  if (heavy.size) {
    const names = [...heavy.keys()].sort();
    const [first] = [...heavy.values()];
    return { size: 'large', reason: `${first} runs ${names.join(', ')}.` };
  }
  if (busiest) {
    return { size: 'large', reason: `${busiest.path} runs ${busiest.count} services, including the database ${busiest.database}.` };
  }
  return {
    size: 'standard',
    reason: scanned ? 'The compose files describe a small stack.' : 'No compose file found.',
  };
}

/** The line every session turn carries, so an agent does not start a heavy stack without need. */
export const SANDBOX_SERVICES_NOTE =
  'Start Docker stacks or database services (ClickHouse, Kafka, Postgres and the like) only when a test needs them. ' +
  'Prefer tests that do not. Stop the services you started when you are done.';
