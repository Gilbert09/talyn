import { useEffect, useState } from 'react';
import { Minus, Monitor, Moon, Plus, Sun } from 'lucide-react';
import {
  DEFAULT_ZOOM_FACTOR,
  MAX_ZOOM_FACTOR,
  MIN_ZOOM_FACTOR,
  formatZoomPercent,
  type ZoomStep,
} from '../../../../main/zoomSteps';
import { formatKeys } from '../../../lib/shortcuts';
import { cn } from '../../../lib/utils';
import { useWorkspaceStore, type Theme } from '../../../stores/workspace';
import { Button } from '../../ui/button';
import { SettingRow, SettingsPage, SettingsSection } from '../../ui/settings';

/** The window zoom, kept in step with the menu and the keyboard. */
function useWindowZoom(): { factor: number | null; step: (step: ZoomStep) => void } {
  const [factor, setFactor] = useState<number | null>(null);
  useEffect(() => {
    const zoom = window.electron?.zoom;
    if (!zoom) return undefined;
    let live = true;
    void zoom.get().then((f) => {
      if (live) setFactor(f);
    });
    const unsubscribe = zoom.onChange(setFactor);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  const step = (s: ZoomStep) => {
    void window.electron?.zoom?.step(s).then(setFactor);
  };
  return { factor, step };
}

function ZoomSection() {
  const { factor, step } = useWindowZoom();
  if (factor === null) return null;
  return (
    <SettingsSection title="Zoom">
      <SettingRow
        label="Size"
        description={`Make everything bigger or smaller, the session transcript included. ${formatKeys('mod+=')} zooms in, ${formatKeys('mod+-')} zooms out and ${formatKeys('mod+0')} resets.`}
      >
        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7"
          aria-label="Zoom out"
          disabled={factor <= MIN_ZOOM_FACTOR}
          onClick={() => step('out')}
        >
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <span className="w-12 text-center tabular-nums" aria-live="polite">
          {formatZoomPercent(factor)}
        </span>
        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7"
          aria-label="Zoom in"
          disabled={factor >= MAX_ZOOM_FACTOR}
          onClick={() => step('in')}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={factor === DEFAULT_ZOOM_FACTOR}
          onClick={() => step('reset')}
        >
          Reset
        </Button>
      </SettingRow>
    </SettingsSection>
  );
}

export function AppearanceSettings() {
  const { theme, setTheme } = useWorkspaceStore();

  const themeOptions: { value: Theme; label: string; icon: typeof Sun; description: string }[] = [
    {
      value: 'light',
      label: 'Light',
      icon: Sun,
      description: 'A clean, bright interface for well-lit environments',
    },
    {
      value: 'dark',
      label: 'Dark',
      icon: Moon,
      description: 'Easy on the eyes in low-light conditions',
    },
    {
      value: 'system',
      label: 'System',
      icon: Monitor,
      description: 'Automatically matches your operating system theme',
    },
  ];

  return (
    <SettingsPage title="Appearance" description="Customize the look and feel of Talyn">
      <SettingsSection title="Theme">
        <div className="space-y-2 p-3">
          <div className="grid grid-cols-3 gap-2">
            {themeOptions.map((option) => (
              <button
                key={option.value}
                onClick={() => setTheme(option.value)}
                className={cn(
                  'flex flex-col items-center gap-1.5 p-3 rounded-md border transition-colors',
                  theme === option.value
                    ? 'border-primary bg-primary/5'
                    : 'border-transparent bg-secondary hover:bg-secondary/80'
                )}
              >
                <div
                  className={cn(
                    'w-8 h-8 rounded-md flex items-center justify-center',
                    theme === option.value ? 'bg-primary text-primary-foreground' : 'bg-muted'
                  )}
                >
                  <option.icon className="w-4 h-4" />
                </div>
                <span className="font-medium text-[13px]">{option.label}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {themeOptions.find((o) => o.value === theme)?.description}
          </p>
        </div>
      </SettingsSection>
      <ZoomSection />
    </SettingsPage>
  );
}
