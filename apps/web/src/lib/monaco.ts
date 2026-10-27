// Loaded only through the lazy CodeViewer chunk. Importing this module from
// anything the app loads at start would put Monaco in the main bundle.
import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/features/codicon/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/folding/register';
import 'monaco-editor/features/stickyScroll/register';
import 'monaco-editor/features/links/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/contextmenu/register';
import 'monaco-editor/features/bracketMatching/register';
// Monarch grammars only. Monaco loads each grammar when a file needs it.
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/go/register';
import 'monaco-editor/languages/definitions/rust/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/yaml/register';
import 'monaco-editor/languages/definitions/shell/register';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/definitions/scss/register';
import 'monaco-editor/languages/definitions/less/register';
import 'monaco-editor/languages/definitions/html/register';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/languages/definitions/dockerfile/register';
import 'monaco-editor/languages/definitions/ini/register';
import 'monaco-editor/languages/definitions/java/register';
import 'monaco-editor/languages/definitions/cpp/register';
import 'monaco-editor/languages/definitions/csharp/register';
import 'monaco-editor/languages/definitions/ruby/register';
import 'monaco-editor/languages/definitions/php/register';
import 'monaco-editor/languages/definitions/kotlin/register';
import 'monaco-editor/languages/definitions/swift/register';
import 'monaco-editor/languages/definitions/xml/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { hslTokenToHex, JSON_LANGUAGE, languageForPath } from './codeViewer';

// The base editor worker only (links, word ranges). Vite emits it as its own
// file under /assets (never a blob: URL), so script-src 'self' covers it.
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

monaco.languages.register({ ...JSON_LANGUAGE, aliases: ['JSON'] });
monaco.languages.setMonarchTokensProvider('json', {
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key.json'],
      [/"(?:[^"\\]|\\.)*"/, 'string.value.json'],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number.json'],
      [/\b(?:true|false|null)\b/, 'keyword.json'],
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      [/[{}[\]]/, '@brackets'],
      [/[,:]/, 'delimiter'],
    ],
    comment: [
      [/[^*/]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[*/]/, 'comment'],
    ],
  },
});
monaco.languages.setLanguageConfiguration('json', {
  brackets: [
    ['{', '}'],
    ['[', ']'],
  ],
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
});

export { monaco };

export function languageIdFor(path: string): string {
  return languageForPath(path, monaco.languages.getLanguages());
}

function token(styles: CSSStyleDeclaration, name: string): string | undefined {
  return hslTokenToHex(styles.getPropertyValue(name)) ?? undefined;
}

/** Defines and applies a theme whose colors come from the app's own CSS tokens. */
export function applyAppTheme(dark: boolean): void {
  const styles = getComputedStyle(document.documentElement);
  const background = token(styles, '--background');
  const foreground = token(styles, '--foreground');
  const muted = token(styles, '--muted-foreground');
  const border = token(styles, '--border');
  const colors: Record<string, string> = {};
  const set = (key: string, value: string | undefined) => {
    if (value) colors[key] = value;
  };
  set('editor.background', background);
  set('editorGutter.background', background);
  set('editorStickyScroll.background', background);
  set('editor.foreground', foreground);
  set('editorLineNumber.foreground', muted && `${muted}99`);
  set('editorLineNumber.activeForeground', muted);
  set('editorStickyScroll.border', border);
  set('editorWidget.border', border);
  const name = dark ? 'talyn-dark' : 'talyn-light';
  monaco.editor.defineTheme(name, { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [], colors });
  monaco.editor.setTheme(name);
}
