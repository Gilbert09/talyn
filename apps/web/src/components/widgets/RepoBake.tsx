import { useEffect, useState } from 'react';
import { validateRepositoryBake, type BakeStep, type RepositoryBake } from '@talyn/shared';
import { api } from '../../lib/api';

const hint = "Run once when Talyn builds this repository's base image, after dependencies install. Use for big downloads such as test databases.";

export function RepoBake({ repositoryId, onChange }: {
  repositoryId: string;
  onChange: (bake: RepositoryBake) => void;
}) {
  const [steps, setSteps] = useState<BakeStep[]>([]);
  const [hosts, setHosts] = useState<string[]>([]);
  const [hostInput, setHostInput] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void api.repositories.bake.get(repositoryId).then((bake) => {
      if (!active) return;
      setSteps(bake?.steps ?? []);
      setHosts(bake?.hosts ?? []);
      onChange(bake ?? { steps: [] });
    }).catch((err) => { if (active) setError(err instanceof Error ? err.message : 'Could not load bake steps.'); });
    return () => { active = false; };
  }, [repositoryId]);

  const editStep = (index: number, patch: Partial<BakeStep>) => {
    setSteps((previous) => previous.map((step, i) => i === index ? { ...step, ...patch } : step));
    setError('');
  };
  const moveStep = (index: number, offset: number) => {
    setSteps((previous) => {
      const next = [...previous];
      [next[index], next[index + offset]] = [next[index + offset], next[index]];
      return next;
    });
  };
  const addHost = () => {
    const host = hostInput.trim();
    if (!host) return;
    try {
      validateRepositoryBake({ steps: [], hosts: [...hosts, host] });
      setHosts((previous) => [...previous, host]);
      setHostInput('');
      setError('');
    } catch (err) { setError((err as Error).message); }
  };
  const save = async () => {
    let bake: RepositoryBake;
    try {
      bake = validateRepositoryBake(steps.length === 0 ? { steps: [] } : { steps, hosts: [...hosts, ...(hostInput.trim() ? [hostInput.trim()] : [])] });
    } catch (err) { setError((err as Error).message); return; }
    setSaving(true);
    setError('');
    try {
      const saved = await api.repositories.bake.put(repositoryId, bake);
      setSteps(saved.steps);
      setHosts(saved.hosts ?? []);
      setHostInput('');
      onChange(saved);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save bake steps.'); }
    finally { setSaving(false); }
  };

  return <div className="min-w-0 space-y-2 text-xs" data-attr="repo-bake">
    <p className="text-muted-foreground">{hint}</p>
    {steps.map((step, index) => <div key={index} className="space-y-1 rounded border p-2">
      <div className="flex gap-1">
        <input aria-label={`Step ${index + 1} name`} value={step.name} onChange={(event) => editStep(index, { name: event.target.value })} placeholder="Name" className="min-w-0 flex-1 rounded border bg-background px-2 py-1" />
        <button type="button" aria-label={`Move step ${index + 1} up`} disabled={index === 0} onClick={() => moveStep(index, -1)}>↑</button>
        <button type="button" aria-label={`Move step ${index + 1} down`} disabled={index === steps.length - 1} onClick={() => moveStep(index, 1)}>↓</button>
        <button type="button" aria-label={`Remove step ${index + 1}`} onClick={() => setSteps((previous) => previous.filter((_, i) => i !== index))}>Remove</button>
      </div>
      <textarea aria-label={`Step ${index + 1} command`} value={step.run} onChange={(event) => editStep(index, { run: event.target.value })} placeholder="Command" rows={3} className="w-full rounded border bg-background px-2 py-1 font-mono" />
      <label className="flex items-center gap-2">Timeout seconds
        <input aria-label={`Step ${index + 1} timeout seconds`} type="number" min={1} max={1800} value={step.timeoutSec ?? 300} onChange={(event) => editStep(index, { timeoutSec: Number(event.target.value) })} className="w-20 rounded border bg-background px-2 py-1" />
      </label>
    </div>)}
    <button type="button" onClick={() => setSteps((previous) => [...previous, { name: '', run: '', timeoutSec: 300 }])} disabled={steps.length >= 10} className="text-primary">Add step</button>
    <div className="space-y-1">
      <label htmlFor={`bake-host-${repositoryId}`}>Allowed hosts</label>
      <div className="flex flex-wrap gap-1">{hosts.map((host, index) => <span key={`${host}-${index}`} className="rounded border px-1">{host} <button type="button" aria-label={`Remove host ${host}`} onClick={() => setHosts((previous) => previous.filter((_, i) => i !== index))}>×</button></span>)}</div>
      <div className="flex gap-1"><input id={`bake-host-${repositoryId}`} value={hostInput} onChange={(event) => setHostInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addHost(); } }} placeholder="downloads.example.com" className="min-w-0 flex-1 rounded border bg-background px-2 py-1" /><button type="button" onClick={addHost}>Add host</button></div>
    </div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <button type="button" onClick={() => void save()} disabled={saving} className="rounded border px-2 py-1">{saving ? 'Saving…' : 'Save bake steps'}</button>
  </div>;
}
