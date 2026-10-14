import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useWorkspaceStore, type Theme } from '../../../stores/workspace';
import { SettingsPage, SettingsSection } from '../../ui/settings';

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
    </SettingsPage>
  );
}
