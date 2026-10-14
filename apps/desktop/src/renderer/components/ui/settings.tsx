import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

/** Scrollable settings page body with a title and optional one-line description. */
export function SettingsPage({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-xl space-y-6 px-6 py-5">
      <div className="space-y-1">
        <h1 className="text-[13px] font-semibold">{title}</h1>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}

/** A labelled group: uppercase label (plus optional actions) above a divided card of rows. */
export function SettingsSection({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
        {actions}
      </div>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      <div className="divide-y divide-border/60 rounded-lg border border-border bg-card">
        {children}
      </div>
    </section>
  );
}

/** One row in a SettingsSection: label and description on the left, control on the right. */
export function SettingRow({
  label,
  description,
  children,
  className,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 px-3 py-2 text-[13px]',
        className
      )}
    >
      <div className="min-w-0 flex-1">
        <div>{label}</div>
        {description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}

/** A checkbox row with a label and optional description; renders as a SettingsSection row. */
export function SettingToggle({
  label,
  description,
  checked,
  onChange,
  disabled,
  className,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 px-3 py-2 text-[13px]',
        disabled && 'cursor-not-allowed opacity-60',
        className
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <div>{label}</div>
        {description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </label>
  );
}

/** Compact native select (`h-7 text-xs`); same props as the old SettingsPanel SettingsSelect. */
export function SettingsSelect({
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cn('relative shrink-0', className)}>
      <select
        {...props}
        className="h-7 w-full appearance-none rounded-md border border-input bg-background bg-none pl-2.5 pr-7 text-xs disabled:opacity-60"
      />
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}
