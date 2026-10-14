import * as React from 'react';
import { cn } from '../../lib/utils';

/** Page title bar: optional icon, title, and an actions slot pushed to the right. */
export function PageHeader({
  title,
  icon,
  actions,
  children,
  className,
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  /** Extra content placed right after the title (tabs, counts). */
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex shrink-0 items-center gap-3 border-b px-4 py-1.5', className)}>
      {icon}
      <h1 className="text-[13px] font-semibold">{title}</h1>
      {children}
      {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
