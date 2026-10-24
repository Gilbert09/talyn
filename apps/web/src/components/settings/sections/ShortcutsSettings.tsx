import { useSyncExternalStore } from 'react';
import { formatKeys, getShortcuts, subscribeShortcuts, type Shortcut } from '../../../lib/shortcuts';
import { MENU_COMMANDS } from '../../../lib/menuCommands';
import { Kbd } from '../../ui/kbd';
import { SettingRow, SettingsPage, SettingsSection } from '../../ui/settings';

const JUMP_PREFIX = 'workbench.jump.';

interface Row {
  id: string;
  label: string;
  keys: string;
}

let version = 0;
function subscribe(listener: () => void): () => void {
  return subscribeShortcuts(() => {
    version += 1;
    listener();
  });
}
const readVersion = () => version;

/**
 * Every shortcut, grouped. The shell's list is built here rather than read
 * from the registry, so the page is complete whatever is mounted; anything
 * else registered now is added. The nine "Open session N" chords are one row.
 */
export function shortcutRows(shortcuts: Shortcut[]): Array<{ group: string; rows: Row[] }> {
  const byId = new Map<string, Shortcut>();
  for (const s of shortcuts) byId.set(s.id, s);
  const groups = new Map<string, Row[]>();
  let jumpsAdded = false;
  for (const s of byId.values()) {
    let row: Row = { id: s.id, label: s.label, keys: formatKeys(s.keys) };
    if (s.id.startsWith(JUMP_PREFIX)) {
      if (jumpsAdded) continue;
      jumpsAdded = true;
      row = { id: 'workbench.jump', label: 'Open session 1–9', keys: formatKeys(s.keys.replace(/\d$/, '1–9')) };
    }
    const rows = groups.get(s.group) ?? [];
    rows.push(row);
    groups.set(s.group, rows);
  }
  return [...groups].map(([group, rows]) => ({ group, rows }));
}

export function ShortcutsSettings() {
  // Re-render when the registry changes.
  useSyncExternalStore(subscribe, readVersion);
  const groups = shortcutRows([
    ...getShortcuts(),
    ...MENU_COMMANDS.map((command) => ({
      id: command.id,
      label: command.label,
      keys: command.keys,
      group: command.section,
      run: () => {},
    })),
  ]);

  return (
    <SettingsPage title="Shortcuts" description="Keyboard shortcuts. Some apply only inside a session.">
      {groups.map(({ group, rows }) => (
        <SettingsSection key={group} title={group}>
          {rows.map((row) => (
            <SettingRow key={row.id} label={row.label}>
              <Kbd keys={row.keys} />
            </SettingRow>
          ))}
        </SettingsSection>
      ))}
    </SettingsPage>
  );
}
