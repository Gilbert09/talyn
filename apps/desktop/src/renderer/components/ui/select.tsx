import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, label, error, ...props }, ref) => {
    return (
      <div className="space-y-1">
        {label && (
          <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
            {label}
          </label>
        )}
        <div className="relative">
          <select
            className={cn(
              // `pr-9`, not `px-3`: the chevron below is absolutely positioned over this
              // element, so the padding has to RESERVE its space rather than leave it
              // to luck. It occupies 12px→28px from the right edge, and with `px-3`
              // the value ran underneath it on any select narrow enough to shrink to
              // its content — an hour picker reading "09" with an arrow through it.
              // Wide selects never showed it, which is why it survived this long.
              'flex h-10 w-full items-center justify-between rounded-md border border-input bg-background pl-3 pr-9 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 appearance-none',
              error && 'border-red-500',
              className
            )}
            ref={ref}
            {...props}
          >
            {children}
          </select>
          <ChevronDown className="absolute right-3 top-3 h-4 w-4 opacity-50 pointer-events-none" />
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    );
  }
);
Select.displayName = 'Select';
