import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

/** The fields of Electron's `context-menu` params that the menu reads. */
export type EditContextMenuParams = Pick<
  ContextMenuParams,
  | 'isEditable'
  | 'misspelledWord'
  | 'dictionarySuggestions'
  | 'selectionText'
  | 'linkURL'
  | 'editFlags'
>;

export interface EditContextMenuActions {
  replaceMisspelling: (word: string) => void;
  addToDictionary: (word: string) => void;
  copyLink: (url: string) => void;
  /** Only in development builds. */
  inspect?: () => void;
}

const MAX_SUGGESTIONS = 5;

/**
 * The native right-click menu: spelling fixes and edit commands in text
 * fields, Copy for selected text, Copy Link for links. An empty list means
 * no menu. Renderer menus (Radix, Monaco) cancel the DOM event, so Electron
 * does not ask for this menu there.
 */
export function buildEditContextMenuTemplate(
  params: EditContextMenuParams,
  actions: EditContextMenuActions,
): MenuItemConstructorOptions[] {
  const groups: MenuItemConstructorOptions[][] = [];
  const { editFlags } = params;
  const hasSelection = params.selectionText.trim().length > 0;

  if (params.isEditable && params.misspelledWord) {
    const word = params.misspelledWord;
    const suggestions = params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS);
    groups.push([
      ...(suggestions.length > 0
        ? suggestions.map(
            (suggestion): MenuItemConstructorOptions => ({
              label: suggestion,
              click: () => actions.replaceMisspelling(suggestion),
            }),
          )
        : [{ label: 'No Guesses Found', enabled: false }]),
      { type: 'separator' },
      { label: 'Add to Dictionary', click: () => actions.addToDictionary(word) },
    ]);
  }

  if (params.isEditable) {
    groups.push([
      { role: 'undo', enabled: editFlags.canUndo },
      { role: 'redo', enabled: editFlags.canRedo },
    ]);
    groups.push([
      { role: 'cut', enabled: editFlags.canCut && hasSelection },
      { role: 'copy', enabled: editFlags.canCopy && hasSelection },
      { role: 'paste', enabled: editFlags.canPaste },
      { role: 'selectAll', enabled: editFlags.canSelectAll },
    ]);
  } else if (hasSelection) {
    groups.push([{ role: 'copy', enabled: editFlags.canCopy }]);
  }

  if (params.linkURL) {
    const url = params.linkURL;
    groups.push([{ label: 'Copy Link', click: () => actions.copyLink(url) }]);
  }

  if (actions.inspect) {
    groups.push([{ label: 'Inspect Element', click: actions.inspect }]);
  }

  return groups.flatMap((group, i) =>
    i === 0 ? group : [{ type: 'separator' as const }, ...group],
  );
}
