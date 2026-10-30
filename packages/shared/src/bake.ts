export interface BakeStep {
  name: string;
  run: string;
  timeoutSec?: number;
}

export interface RepositoryBake {
  steps: BakeStep[];
  hosts?: string[];
}

export interface BakeStepResult {
  name: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  logTail: string;
}

const bytes = (value: string) => new TextEncoder().encode(value).length;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function validHost(host: string): boolean {
  const name = host.startsWith('*.') ? host.slice(2) : host;
  if (bytes(host) > 255 || !name.includes('.') || /^\d+(?:\.\d+){3}$/.test(name)) return false;
  return name.split('.').every((label) =>
    label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

/** Validate the fleet's tenant bake shape. Throw a field-specific error for forms and routes. */
export function validateRepositoryBake(value: unknown): RepositoryBake {
  if (!object(value) || Object.keys(value).some((key) => !['steps', 'hosts'].includes(key))) {
    throw new Error('Bake must contain steps and optional hosts.');
  }
  if (!Array.isArray(value.steps) || value.steps.length > 10) throw new Error('Bake needs at most 10 steps.');
  const steps = value.steps.map((raw, index): BakeStep => {
    const field = `Step ${index + 1}`;
    if (!object(raw) || Object.keys(raw).some((key) => !['name', 'run', 'timeoutSec'].includes(key))) {
      throw new Error(`${field} has invalid fields.`);
    }
    if (typeof raw.name !== 'string' || bytes(raw.name) < 1 || bytes(raw.name) > 128 || /[\r\n]/.test(raw.name)) {
      throw new Error(`${field} name must be 1 to 128 bytes with no line breaks.`);
    }
    if (typeof raw.run !== 'string' || bytes(raw.run) < 1 || bytes(raw.run) > 4096 || raw.run.includes('\0')) {
      throw new Error(`${field} command must be 1 to 4096 bytes with no NUL bytes.`);
    }
    if (raw.timeoutSec !== undefined && (!Number.isInteger(raw.timeoutSec) || (raw.timeoutSec as number) < 1 || (raw.timeoutSec as number) > 1800)) {
      throw new Error(`${field} timeout must be 1 to 1800 seconds.`);
    }
    return { name: raw.name, run: raw.run, ...(raw.timeoutSec === undefined ? {} : { timeoutSec: raw.timeoutSec as number }) };
  });
  if (value.hosts !== undefined && (!Array.isArray(value.hosts) || value.hosts.length > 10 ||
    value.hosts.some((host) => typeof host !== 'string' || !validHost(host)))) {
    throw new Error('Allowed hosts must be at most 10 DNS names or leading *. wildcards.');
  }
  return { steps, ...(steps.length === 0 || value.hosts === undefined ? {} : { hosts: value.hosts as string[] }) };
}
