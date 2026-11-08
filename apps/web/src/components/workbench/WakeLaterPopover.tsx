import { useState } from 'react';
import { AlarmClock } from 'lucide-react';
import { WAKEUP_REASON_MAX_CHARS } from '@talyn/shared';
import { api } from '../../lib/api';
import { wakeLaterPresets } from '../../lib/sessionBackground';
import { toast } from '../../stores/toast';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

export function WakeLaterPopover({ workbenchId, chatId }: { workbenchId: string; chatId: string }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const presets = wakeLaterPresets(new Date());
  const choice = presets.find((preset) => preset.id === selected);

  const schedule = async () => {
    if (!choice || !reason.trim()) return;
    setSaving(true);
    try {
      await api.workbenches.scheduleWakeup(workbenchId, { chatId, delaySeconds: choice.delaySeconds, reason: reason.trim() });
      setOpen(false);
      setSelected(null);
      setReason('');
      toast.success('Wake-up set');
    } catch (error) {
      toast.error('Could not set wake-up', error instanceof Error ? error.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Wake me later" title="Wake me later" className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><AlarmClock className="h-4 w-4" /></button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-3">
        <p className="font-medium">Wake me later</p>
        <div className="flex flex-wrap gap-1.5" aria-label="Wake-up time">
          {presets.map((preset) => <button key={preset.id} type="button" aria-pressed={selected === preset.id} onClick={() => setSelected(preset.id)} className={`rounded border px-2 py-1 text-xs hover:bg-accent ${selected === preset.id ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground'}`}>{preset.label}</button>)}
        </div>
        <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={WAKEUP_REASON_MAX_CHARS} placeholder="What should the agent do when it wakes?" aria-label="Wake-up reason" rows={3} className="w-full resize-none rounded-md border bg-background p-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring" />
        <button type="button" disabled={!choice || !reason.trim() || saving} onClick={() => void schedule()} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40">Schedule</button>
      </PopoverContent>
    </Popover>
  );
}
