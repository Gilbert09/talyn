import { describe, it, expect } from 'vitest';
import { applyTrigger, findTrigger } from '../components/workbench/ComposerPopover';
describe('composer triggers', () => {
  it.each([
    ['a mention at the start', '@sr', 3, { kind: 'mention', query: 'sr', start: 0, end: 3 }],
    ['a mention after a space', 'look at @src/a', 14, { kind: 'mention', query: 'src/a', start: 8, end: 14 }],
    ['an email is not a mention', 'mail me@x', 9, null],
    ['a slash command at the start', '/rev', 4, { kind: 'slash', query: 'rev', start: 0, end: 4 }],
    ['a slash mid-text is not a command', 'see a/b', 7, null],
    ['nothing after a space', '@src ', 5, null],
  ])('findTrigger: %s', (_n, text, caret, expected) => {
    expect(findTrigger(text, caret)).toEqual(expected);
  });

  it('applies a mention and moves the caret past it', () => {
    const text = 'look at @sr please';
    const trigger = findTrigger(text, 11);
    expect(trigger).not.toBeNull();
    expect(applyTrigger(text, trigger!, 'src/app.ts')).toEqual({
      text: 'look at @src/app.ts  please',
      caret: 20,
    });
  });

  it('applies a slash command', () => {
    const trigger = findTrigger('/re', 3)!;
    expect(applyTrigger('/re', trigger, 'review')).toEqual({
      text: '/review ',
      caret: 8,
    });
  });
});
