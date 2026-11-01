import { parseAnsi } from '../renderer/components/workbench/terminal/ansi';
import { CONSOLE_THEME, TALYN_COLOR } from '../renderer/components/workbench/terminal/consoleTheme';

describe('script ANSI output', () => {
  it('renders ANSI colors and text styles', () => {
    const spans = parseAnsi('\x1b[31mred\x1b[1mbold\x1b[2mdim\x1b[0mplain\x1b[94mblue');
    expect(spans.map((span) => span.text)).toEqual(['red', 'bold', 'dim', 'plain', 'blue']);
    expect(spans[0]).toMatchObject({ color: CONSOLE_THEME.red, bold: false, dim: false });
    expect(spans[1]).toMatchObject({ color: CONSOLE_THEME.brightRed, bold: true, dim: false });
    expect(spans[2]).toMatchObject({ color: CONSOLE_THEME.brightRed, bold: true, dim: true });
    expect(spans[3]).toMatchObject({ color: undefined, bold: false, dim: false });
    expect(spans[4]).toMatchObject({ color: CONSOLE_THEME.brightBlue, bold: false });
  });

  it('ignores unknown codes and resets the color', () => {
    const spans = parseAnsi('\x1b[32mgreen\x1b[999mstill green\x1b[39mplain');
    expect(spans.map((span) => span.text)).toEqual(['greenstill green', 'plain']);
    expect(spans.map((span) => span.color)).toEqual([CONSOLE_THEME.green, undefined]);
  });

  it('marks Talyn lines and keeps HTML as text', () => {
    const spans = parseAnsi('app\n\x1b[31mTalyn: <img src=x>\x1b[0m\napp');
    expect(spans.filter((span) => span.text.includes('Talyn: '))[0].color).toBe(TALYN_COLOR);
    expect(spans.map((span) => span.text).join('')).toBe('app\nTalyn: <img src=x>\napp');
  });
});
