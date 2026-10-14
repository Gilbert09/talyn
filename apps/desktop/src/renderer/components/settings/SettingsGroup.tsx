import * as React from 'react';

/**
 * A labelled group for content that brings its own boxes (provider cards,
 * sub-panels). `SettingsSection` wraps its children in one divided card,
 * which would put a border around a border here.
 */
export function SettingsGroup({
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
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
        {actions}
      </div>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      <div className="space-y-3">{children}</div>
    </section>
  );
}
