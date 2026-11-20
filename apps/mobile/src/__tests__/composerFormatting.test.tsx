import { render, screen } from '@testing-library/react-native';
import { Text, TextInput } from 'react-native';

import { ComposerFormattedText } from '../features/chat/ComposerFormatting';
import { fonts } from '../theme/tokens';

function styleOf(text: string) {
  const node = screen.getAllByText(text, { exact: true }).at(-1)!;
  return Object.assign({}, ...[node.props.style].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
}

describe('ComposerFormattedText', () => {
  it('keeps the whole draft, markers included, as the field text', async () => {
    const draft = '> Batch #0 takes about 44 minutes\nYeah this is **an issue** in `run.ts`';
    await render(<TextInput accessibilityLabel="Message" multiline><ComposerFormattedText text={draft} /></TextInput>);
    expect(screen.getByLabelText('Message')).toHaveTextContent(draft);
  });

  it.each([
    ['bold', 'a **b** c', 'b', { fontFamily: fonts.sans[600] }],
    ['inline code', 'run `npm test`', 'npm test', { fontFamily: fonts.mono[400] }],
    ['a strike', '~~gone~~', 'gone', { textDecorationLine: 'line-through' }],
    ['a link', '[docs](https://x.dev)', 'docs', { textDecorationLine: 'underline' }],
  ])('styles %s', async (_name, draft, part, expected) => {
    await render(<Text><ComposerFormattedText text={draft} /></Text>);
    expect(styleOf(part)).toMatchObject(expected);
  });

  it('leaves plain text unstyled', async () => {
    await render(<Text testID="out"><ComposerFormattedText text="just words" /></Text>);
    expect(screen.getByTestId('out')).toHaveTextContent('just words');
  });
});
