import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Plus, X } from 'lucide-react';
import type { WorkflowActorMatch, WorkflowSuggestions } from '@talyn/shared';
import { WORKFLOW_ACTOR_KIND_LABELS, WORKFLOW_ACTOR_KINDS } from '@talyn/shared';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { cn } from '../../../lib/utils';

/**
 * The editor's input widgets.
 *
 * Two ideas run through all of them. Values are composed by ADDING one at a time
 * rather than typed into a comma-separated box — a chip you can see and remove is
 * legible where `a, b, c` is a parsing exercise. And every suggestion list is
 * advisory: the field always accepts something that was not suggested, because
 * GitHub only has to know the label, and a workspace whose App lacks a permission
 * would otherwise be locked out of a field entirely.
 */

// ---------------------------------------------------------------------------
// A small dropdown. There is no menu primitive in ui/, and this needs one shape
// only: a button that opens a list, closes on pick, on Escape, and on a click
// anywhere else.
// ---------------------------------------------------------------------------

export interface MenuOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export function DropdownButton({
  label,
  options,
  onPick,
  icon,
  variant = 'outline',
  emptyHint = 'Nothing left to add',
  align = 'left',
}: {
  label: string;
  options: MenuOption[];
  onPick: (value: string) => void;
  icon?: React.ReactNode;
  variant?: 'outline' | 'ghost' | 'secondary';
  emptyHint?: string;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative inline-block" ref={ref}>
      <Button variant={variant} size="sm" onClick={() => setOpen((o) => !o)}>
        {icon ?? <Plus className="mr-1 h-4 w-4" />}
        {label}
        <ChevronDown className="ml-1 h-3 w-3 opacity-60" />
      </Button>
      {open && (
        <div
          className={cn(
            'absolute z-30 mt-1 max-h-80 w-72 overflow-auto rounded-md border bg-background p-1 shadow-lg',
            align === 'right' ? 'right-0' : 'left-0'
          )}
        >
          {options.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">{emptyHint}</p>
          ) : (
            options.map((o) => (
              <button
                key={o.value}
                disabled={o.disabled}
                className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-40"
                onClick={() => {
                  onPick(o.value);
                  setOpen(false);
                }}
              >
                <span className="block">{o.label}</span>
                {o.hint && (
                  <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                    {o.hint}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chips + autocomplete
// ---------------------------------------------------------------------------

/**
 * A multi-value field: existing values as removable chips, plus one input that
 * adds another.
 *
 * The suggestion list filters as you type and is picked from with Enter or a
 * click, but Enter on text that matches nothing adds it anyway — see the note at
 * the top of this file. `datalist` is deliberately NOT used here (the PR filter
 * modal does): it cannot show the bot/person distinction, cannot be styled, and
 * on Electron it renders a native popup that sits outside the app's own frame.
 */
export function TokenField({
  values,
  onChange,
  suggestions,
  placeholder,
  label,
  hint,
  renderSuggestion,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  suggestions: string[];
  placeholder?: string;
  label?: string;
  hint?: string;
  renderSuggestion?: (value: string) => React.ReactNode;
}) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    const taken = new Set(values.map((v) => v.toLowerCase()));
    return suggestions
      .filter((s) => !taken.has(s.toLowerCase()))
      .filter((s) => (q ? s.toLowerCase().includes(q) : true))
      .slice(0, 50);
  }, [text, suggestions, values]);

  const add = (value: string) => {
    const v = value.trim();
    if (!v) return;
    if (values.some((x) => x.toLowerCase() === v.toLowerCase())) {
      setText('');
      return;
    }
    onChange([...values, v]);
    setText('');
  };

  return (
    <div className="space-y-1.5">
      {label && <label className="text-xs font-medium text-muted-foreground">{label}</label>}
      {/* The ring belongs on the BOX, not the inner input: the chips and the
          text entry are one control, and lighting up only the text half drew a
          second rectangle inside the first. `focus-within` is what makes the
          whole field respond to the input's focus. */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-background px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-xs"
          >
            {v}
            <button
              className="opacity-60 hover:opacity-100"
              onClick={() => onChange(values.filter((x) => x !== v))}
              aria-label={`Remove ${v}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <div className="relative min-w-32 flex-1">
          <input
            // Chrome draws its own blue ring on `:focus-visible`, which the app's
            // global `*:focus { outline: none }` does not cover — so both are
            // named here explicitly rather than relying on the shorthand.
            className="w-full bg-transparent py-0.5 text-sm placeholder:text-muted-foreground focus:outline-none focus-visible:outline-none focus-visible:ring-0"
            value={text}
            placeholder={values.length === 0 ? placeholder : 'Add another...'}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setFocused(true)}
            // A blur that fires before a suggestion's click handler would close
            // the list and swallow the pick, so the close is deferred.
            onBlur={() => window.setTimeout(() => setFocused(false), 150)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add(matches.length === 1 && text.trim() ? matches[0]! : text);
              } else if (e.key === 'Backspace' && !text && values.length > 0) {
                onChange(values.slice(0, -1));
              }
            }}
          />
          {focused && (matches.length > 0 || suggestions.length === 0) && (
            <div className="absolute left-0 z-30 mt-1 max-h-56 w-64 overflow-auto rounded-md border bg-background p-1 shadow-lg">
              {matches.length === 0 ? (
                // Say so, rather than showing nothing. An empty list is the
                // expected state when a permission is missing or GitHub is
                // rate-limited, and silence there reads as a broken field — which
                // is exactly how it read the first time.
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  No suggestions loaded. Type a value and press Enter.
                </p>
              ) : (
                matches.map((s) => (
                  <button
                    key={s}
                    className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-accent"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => add(s)}
                  >
                    {renderSuggestion ? renderSuggestion(s) : s}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** People and teams share a field; the suggestion list says which is which. */
export function PeopleField({
  logins,
  teams,
  onChange,
  suggestions,
  label,
  hint,
  includeTeams = true,
}: {
  logins: string[];
  teams: string[];
  onChange: (next: { logins: string[]; teams: string[] }) => void;
  suggestions: WorkflowSuggestions | null;
  label?: string;
  hint?: string;
  includeTeams?: boolean;
}) {
  const TEAM_PREFIX = 'team:';
  // One field over two lists, because "who" is one question. A value prefixed
  // `team:` is a team; the prefix is also what a user types to name a team the
  // suggestion list could not offer (listing teams needs `members: read`).
  const values = [...logins, ...teams.map((t) => `${TEAM_PREFIX}${t}`)];
  const people = suggestions?.people ?? [];
  const suggested = [
    ...people.map((p) => p.login),
    ...(includeTeams ? (suggestions?.teams ?? []).map((t) => `${TEAM_PREFIX}${t}`) : []),
  ];
  const botLogins = new Set(people.filter((p) => p.isBot).map((p) => p.login.toLowerCase()));

  return (
    <TokenField
      label={label}
      hint={
        hint ??
        (includeTeams
          ? 'GitHub logins. Prefix a team slug with "team:".'
          : 'GitHub logins.')
      }
      values={values}
      suggestions={suggested}
      placeholder={includeTeams ? 'alice, team:frontend' : 'alice'}
      renderSuggestion={(v) => (
        <span className="flex items-center justify-between gap-2">
          <span>{v.startsWith(TEAM_PREFIX) ? v.slice(TEAM_PREFIX.length) : v}</span>
          <span className="text-xs text-muted-foreground">
            {v.startsWith(TEAM_PREFIX) ? 'team' : botLogins.has(v.toLowerCase()) ? 'bot' : ''}
          </span>
        </span>
      )}
      onChange={(next) =>
        onChange({
          logins: next.filter((v) => !v.startsWith(TEAM_PREFIX)),
          teams: next
            .filter((v) => v.startsWith(TEAM_PREFIX))
            .map((v) => v.slice(TEAM_PREFIX.length))
            .filter(Boolean),
        })
      }
    />
  );
}

/**
 * Who a condition is about: anyone, me, any person, any bot, or named accounts.
 *
 * "Me" is a first-class option rather than something you express by typing your
 * own login — it keeps working when the connected account changes, and it is what
 * "run a skill when I am asked to review" actually means.
 */
export function ActorField({
  value,
  onChange,
  suggestions,
  hint,
}: {
  value: WorkflowActorMatch | undefined;
  onChange: (next: WorkflowActorMatch) => void;
  suggestions: WorkflowSuggestions | null;
  hint?: string;
}) {
  const kind = value?.kind ?? 'any';
  const logins = value?.kind === 'logins' ? value.logins : [];
  const teams = value?.kind === 'logins' ? (value.teams ?? []) : [];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {WORKFLOW_ACTOR_KINDS.map((k) => (
          <button
            key={k}
            onClick={() =>
              onChange(k === 'logins' ? { kind: 'logins', logins: [], teams: [] } : { kind: k })
            }
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
              kind === k
                ? 'border-transparent bg-primary text-primary-foreground'
                : 'hover:bg-accent'
            )}
          >
            {kind === k && <Check className="h-3 w-3" />}
            {WORKFLOW_ACTOR_KIND_LABELS[k]}
          </button>
        ))}
      </div>
      {kind === 'logins' && (
        <PeopleField
          logins={logins}
          teams={teams}
          suggestions={suggestions}
          onChange={(next) => onChange({ kind: 'logins', ...next })}
        />
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** A checkbox set over a fixed vocabulary (review verdicts, check outcomes). */
export function ChoiceSet<T extends string>({
  options,
  selected,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  selected: readonly T[];
  onChange: (next: T[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => {
        const on = selected.includes(o.value);
        return (
          <button
            key={o.value}
            onClick={() =>
              onChange(on ? selected.filter((s) => s !== o.value) : [...selected, o.value])
            }
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
              on ? 'border-transparent bg-primary text-primary-foreground' : 'hover:bg-accent'
            )}
          >
            {on && <Check className="h-3 w-3" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** One line of text — a title or body substring. */
export function TextField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <Input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  );
}

/** A labelled section with a heading and an optional trailing control. */
export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border">
      <header className="flex items-start gap-3 border-b px-4 py-3">
        <div className="flex-1">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </header>
      <div className="space-y-3 p-4">{children}</div>
    </section>
  );
}

/** One removable row inside a section — a condition or an action. */
export function EditorRow({
  title,
  hint,
  onRemove,
  children,
}: {
  title: string;
  hint?: string;
  onRemove: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border bg-card/40 p-3">
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <div className="text-sm font-medium">{title}</div>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        <Button variant="ghost" size="sm" onClick={onRemove} aria-label={`Remove ${title}`}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      {children && <div className="mt-2.5">{children}</div>}
    </div>
  );
}
