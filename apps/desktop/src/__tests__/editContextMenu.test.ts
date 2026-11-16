import {
  buildEditContextMenuTemplate,
  type EditContextMenuActions,
  type EditContextMenuParams,
} from '../main/editContextMenu';

const allFlags = {
  canUndo: true,
  canRedo: true,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canSelectAll: true,
  canDelete: true,
  canEditRichly: false,
};

function params(over: Partial<EditContextMenuParams> = {}): EditContextMenuParams {
  return {
    isEditable: false,
    misspelledWord: '',
    dictionarySuggestions: [],
    selectionText: '',
    linkURL: '',
    editFlags: allFlags,
    ...over,
  };
}

function actions(over: Partial<EditContextMenuActions> = {}): EditContextMenuActions {
  return {
    replaceMisspelling: jest.fn(),
    addToDictionary: jest.fn(),
    copyLink: jest.fn(),
    ...over,
  };
}

/** One short name per item, so a test can compare the whole menu. */
function shape(params_: EditContextMenuParams, actions_ = actions()): string[] {
  return buildEditContextMenuTemplate(params_, actions_).map((item) => {
    if (item.type === 'separator') return '---';
    if (item.role) return item.enabled === false ? `${item.role}(off)` : item.role;
    return item.enabled === false ? `${item.label}(off)` : String(item.label);
  });
}

describe('buildEditContextMenuTemplate', () => {
  it.each<[string, Partial<EditContextMenuParams>, string[]]>([
    ['plain page, no selection', {}, []],
    ['whitespace-only selection', { selectionText: '  \n' }, []],
    ['selected page text', { selectionText: 'hello' }, ['copy']],
    ['link', { linkURL: 'https://talyn.dev' }, ['Copy Link']],
    [
      'selected link text',
      { selectionText: 'docs', linkURL: 'https://talyn.dev' },
      ['copy', '---', 'Copy Link'],
    ],
    [
      'empty text field',
      {
        isEditable: true,
        editFlags: { ...allFlags, canUndo: false, canRedo: false },
      },
      ['undo(off)', 'redo(off)', '---', 'cut(off)', 'copy(off)', 'paste', 'selectAll'],
    ],
    [
      'text field with a selection',
      { isEditable: true, selectionText: 'word' },
      ['undo', 'redo', '---', 'cut', 'copy', 'paste', 'selectAll'],
    ],
    [
      'text field with nothing to paste',
      { isEditable: true, editFlags: { ...allFlags, canPaste: false } },
      ['undo', 'redo', '---', 'cut(off)', 'copy(off)', 'paste(off)', 'selectAll'],
    ],
    [
      'misspelled word with suggestions',
      {
        isEditable: true,
        misspelledWord: 'seperate',
        dictionarySuggestions: ['separate', 'desperate'],
      },
      [
        'separate',
        'desperate',
        '---',
        'Add to Dictionary',
        '---',
        'undo',
        'redo',
        '---',
        'cut(off)',
        'copy(off)',
        'paste',
        'selectAll',
      ],
    ],
    [
      'misspelled word with no suggestions',
      { isEditable: true, misspelledWord: 'qzxv' },
      [
        'No Guesses Found(off)',
        '---',
        'Add to Dictionary',
        '---',
        'undo',
        'redo',
        '---',
        'cut(off)',
        'copy(off)',
        'paste',
        'selectAll',
      ],
    ],
    [
      'misspelled word outside a text field',
      { misspelledWord: 'seperate', dictionarySuggestions: ['separate'] },
      [],
    ],
  ])('%s', (_name, over, expected) => {
    expect(shape(params(over))).toEqual(expected);
  });

  it('shows at most five suggestions', () => {
    const items = shape(
      params({
        isEditable: true,
        misspelledWord: 'teh',
        dictionarySuggestions: ['the', 'ten', 'tea', 'tee', 'tech', 'tel', 'Ted'],
      }),
    );
    expect(items.slice(0, 6)).toEqual(['the', 'ten', 'tea', 'tee', 'tech', '---']);
  });

  it('runs the actions with the right values', () => {
    const acts = actions();
    const template = buildEditContextMenuTemplate(
      params({
        isEditable: true,
        misspelledWord: 'seperate',
        dictionarySuggestions: ['separate'],
        linkURL: 'https://talyn.dev/docs',
      }),
      acts,
    );
    const click = (label: string) => {
      const item = template.find((i) => i.label === label);
      (item?.click as () => void)();
    };

    click('separate');
    click('Add to Dictionary');
    click('Copy Link');

    expect(acts.replaceMisspelling).toHaveBeenCalledWith('separate');
    expect(acts.addToDictionary).toHaveBeenCalledWith('seperate');
    expect(acts.copyLink).toHaveBeenCalledWith('https://talyn.dev/docs');
  });

  it.each<[string, Partial<EditContextMenuParams>, string[]]>([
    ['plain page', {}, ['Inspect Element']],
    ['selected page text', { selectionText: 'hi' }, ['copy', '---', 'Inspect Element']],
  ])('adds Inspect Element in development: %s', (_name, over, expected) => {
    const inspect = jest.fn();
    expect(shape(params(over), actions({ inspect }))).toEqual(expected);
    const template = buildEditContextMenuTemplate(params(over), actions({ inspect }));
    (template[template.length - 1].click as () => void)();
    expect(inspect).toHaveBeenCalled();
  });
});
