import { CONSOLE_THEME, TALYN_COLOR } from './consoleTheme';

export interface AnsiSpan {
  text: string;
  color?: string;
  bold: boolean;
  dim: boolean;
}

const COLORS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
] as const;
const SGR = new RegExp(String.fromCharCode(27) + '\\[([0-9;]*)m', 'g');

function ansiColor(code: number, bold: boolean): string | undefined {
  const bright = code >= 90 || bold;
  const index = code >= 90 ? code - 90 : code - 30;
  const key = COLORS[index];
  if (!key) return undefined;
  const themeKey = bright ? `bright${key[0].toUpperCase()}${key.slice(1)}` : key;
  return CONSOLE_THEME[themeKey as keyof typeof CONSOLE_THEME] as string | undefined;
}

export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  const lines = input.split('\n');
  let colorCode: number | null = null;
  let bold = false;
  let dim = false;

  lines.forEach((line, lineIndex) => {
    const talyn = line.replace(SGR, '').startsWith('Talyn: ');
    SGR.lastIndex = 0;
    let offset = 0;
    const addText = (text: string) => {
      if (!text) return;
      const color = talyn ? TALYN_COLOR : colorCode === null ? undefined : ansiColor(colorCode, bold);
      const previous = spans[spans.length - 1];
      if (previous && previous.color === color && previous.bold === bold && previous.dim === dim) {
        previous.text += text;
      } else {
        spans.push({ text, color, bold, dim });
      }
    };

    for (let match = SGR.exec(line); match; match = SGR.exec(line)) {
      addText(line.slice(offset, match.index));
      for (const code of (match[1] || '0').split(';').map(Number)) {
        if (code === 0) {
          colorCode = null;
          bold = false;
          dim = false;
        } else if (code === 1) bold = true;
        else if (code === 2) dim = true;
        else if (code === 22) { bold = false; dim = false; }
        else if (code === 39) colorCode = null;
        else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) colorCode = code;
      }
      offset = SGR.lastIndex;
    }
    addText(line.slice(offset));
    if (lineIndex < lines.length - 1) addText('\n');
  });

  return spans;
}
