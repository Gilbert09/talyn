import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Loader2, ChevronDown, Cpu, Brain, Check } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * Slick message composer for the task panel — modelled on the PostHog Code
 * input. A rounded card with an auto-growing textarea, a control row
 * (model + reasoning-effort pickers for cloud tasks), and an icon send
 * button. Enter sends, Shift+Enter inserts a newline, Cmd/Ctrl+Enter also
 * sends, Esc blurs.
 *
 * It deliberately omits PostHog-CLI affordances (@ mentions, ! bash, /
 * skills) — our task backend doesn't support them, so they'd be dead UI.
 */

// Sentinel for "let PostHog Code pick the model". Selecting it omits both
// `model` and `reasoning_effort` from the run request (effort is model-specific
// and can't be validated against a model we haven't chosen).
export const AUTO_MODEL = 'auto';

export const MODEL_OPTIONS: Array<{ id: string; label: string }> = [
  { id: AUTO_MODEL, label: 'Auto' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-opus-4-5', label: 'Opus 4.5' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
];

// Valid reasoning efforts per model (mirrors the PostHog backend's
// CLAUDE_REASONING_EFFORTS_BY_MODEL so we never send a rejected value).
export const EFFORTS_BY_MODEL: Record<string, string[]> = {
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-6': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-5': ['low', 'medium', 'high'],
  'claude-sonnet-4-6': ['low', 'medium', 'high'],
};

const EFFORT_LABEL: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
};

export function modelLabel(id: string): string {
  return MODEL_OPTIONS.find((m) => m.id === id)?.label ?? id;
}

interface TaskComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  /** Hard-disable the whole composer (e.g. mid-turn, or unsupported state). */
  disabled?: boolean;
  /** Show a spinner on the send button while a send is in flight. */
  sending?: boolean;
  placeholder: string;
  /** Cloud (PostHog Code) tasks get model + effort pickers. */
  showModelControls?: boolean;
  model?: string;
  onModelChange?: (id: string) => void;
  effort?: string;
  onEffortChange?: (effort: string) => void;
  /** Optional emphasis (e.g. agent is waiting on the user). */
  attention?: boolean;
  autoFocus?: boolean;
}

export function TaskComposer({
  value,
  onChange,
  onSend,
  disabled = false,
  sending = false,
  placeholder,
  showModelControls = false,
  model,
  onModelChange,
  effort,
  onEffortChange,
  attention = false,
  autoFocus = false,
}: TaskComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow with content, capped so the composer can't eat the panel.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const canSend = value.trim().length > 0 && !disabled && !sending;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        textareaRef.current?.blur();
        return;
      }
      // Enter sends; Shift+Enter is a newline; Cmd/Ctrl+Enter also sends.
      if (e.key === 'Enter' && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (value.trim() && !disabled && !sending) onSend();
      }
    },
    [value, disabled, sending, onSend]
  );

  const efforts = model ? EFFORTS_BY_MODEL[model] ?? [] : [];
  const hasControls =
    showModelControls &&
    ((!!model && !!onModelChange) ||
      (!!effort && !!onEffortChange && efforts.length > 0));

  return (
    <div className="px-3 pt-2.5 pb-3 border-t bg-card">
      <div
        className={cn(
          'group/composer relative rounded-md border bg-background transition-colors',
          attention && 'border-yellow-500/50 bg-yellow-500/[0.04]'
        )}
      >
        {/* Subtle attention marker along the leading edge. */}
        {attention && (
          <span className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-yellow-500/70" />
        )}

        <div className="px-3 pt-2.5 pb-2">
          <textarea
            ref={textareaRef}
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={disabled}
            autoFocus={autoFocus}
            className={cn(
              'w-full resize-none bg-transparent text-sm leading-relaxed',
              'placeholder:text-muted-foreground/60 focus:outline-none',
              'min-h-[24px] max-h-[200px] disabled:opacity-60'
            )}
          />
        </div>

        {/* Control row — sits flush at the bottom of the card with a faint
            divider so the pickers read as a toolbar, not floating text. */}
        <div
          className={cn(
            'flex items-center gap-1.5 px-2 pb-2 pt-0.5',
            hasControls && 'border-t border-border/60 pt-2'
          )}
        >
          {showModelControls && model && onModelChange && (
            <Picker
              icon={<Cpu className="h-3.5 w-3.5" />}
              label={modelLabel(model)}
              value={model}
              options={MODEL_OPTIONS.map((m) => ({ value: m.id, label: m.label }))}
              onSelect={onModelChange}
              disabled={disabled}
            />
          )}
          {showModelControls && effort && onEffortChange && efforts.length > 0 && (
            <Picker
              icon={<Brain className="h-3.5 w-3.5" />}
              label={EFFORT_LABEL[effort] ?? effort}
              value={effort}
              options={efforts.map((e) => ({ value: e, label: EFFORT_LABEL[e] ?? e }))}
              onSelect={onEffortChange}
              disabled={disabled}
            />
          )}

          {/* Keyboard hint — fades in once there's something to send, so the
              affordance is discoverable without cluttering the empty state.
              The `ml-auto` here is what pushes the toolbar's trailing cluster
              to the right edge. */}
          <span
            className={cn(
              'ml-auto mr-1 select-none items-center gap-1 text-[11px] text-muted-foreground/60 transition-opacity',
              'hidden sm:inline-flex',
              canSend ? 'opacity-100' : 'opacity-0'
            )}
          >
            <kbd className="rounded border border-border/70 bg-muted px-1 py-px font-sans text-[10px] font-medium leading-none">
              ↵
            </kbd>
            to send
          </span>

          <button
            type="button"
            onClick={() => canSend && onSend()}
            disabled={!canSend}
            title="Send message  (Enter)"
            aria-label="Send message"
            className={cn(
              'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors',
              // On narrow widths the hint is hidden, so the button itself owns
              // the right-alignment.
              'ml-auto sm:ml-0',
              canSend
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-muted text-muted-foreground/40 cursor-not-allowed'
            )}
          >
            {sending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.5} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Compact inline dropdown for the control row. A button that toggles a
 * small popover list; closes on selection or an outside click.
 */
function Picker({
  icon,
  label,
  value,
  options,
  onSelect,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onSelect: (v: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-xs font-medium text-muted-foreground',
          'transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50',
          open && 'bg-muted text-foreground'
        )}
      >
        <span className="text-muted-foreground/80">{icon}</span>
        <span>{label}</span>
        <ChevronDown
          className={cn('h-3 w-3 opacity-50 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <>
          {/* Backdrop swallows the outside click that closes the menu. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-50 mb-1 min-w-[150px] overflow-hidden rounded-md border bg-popover py-1 shadow-md">
            {options.map((opt) => {
              const selected = opt.value === value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    onSelect(opt.value);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-xs transition-colors',
                    selected
                      ? 'font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  {opt.label}
                  {selected && <Check className="h-3.5 w-3.5 text-primary" />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
