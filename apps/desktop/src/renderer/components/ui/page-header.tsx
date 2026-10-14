import * as React from 'react';
import { cn } from '../../lib/utils';

/**
 * Page title bar: optional icon, title, and an actions slot pushed to the right.
 * `page` is the bar at the top of a view and is the macOS window drag handle;
 * `toolbar` is a sub-bar under it (an editor's back button, name and save).
 */
export function PageHeader({
  title,
  icon,
  actions,
  children,
  className,
  variant = 'page',
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  /** Extra content placed right after the title (tabs, counts). */
  children?: React.ReactNode;
  className?: string;
  variant?: 'page' | 'toolbar';
}) {
  const page = variant === 'page';
  const Title = page ? 'h1' : 'h2';
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-3 border-b px-4',
        page ? 'app-region-drag py-1.5' : 'py-1',
        className
      )}
    >
      {icon && <div className="app-region-no-drag flex items-center">{icon}</div>}
      <Title className="min-w-0 text-[13px] font-semibold">{title}</Title>
      {children && <div className="app-region-no-drag flex min-w-0 items-center">{children}</div>}
      {actions ? <div className="app-region-no-drag ml-auto flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
