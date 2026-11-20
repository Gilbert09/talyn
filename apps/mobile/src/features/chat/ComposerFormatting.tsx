import { Fragment, useMemo } from 'react';
import { Text, type TextStyle } from 'react-native';
import { composerMarkdown, type ComposerLine, type ComposerMark } from '@talyn/shared';

import { mono, sans, useTheme } from '../../theme/tokens';

/**
 * The draft with its Markdown styled, for a TextInput's children (in place of
 * `value`). The markers stay in the text, so the agent still gets Markdown.
 * Same tokens as the web and desktop composers.
 */
export function ComposerFormattedText({ text }: { text: string }) {
  const c = useTheme();
  const lines = useMemo(() => composerMarkdown(text), [text]);
  const markStyle: Record<ComposerMark, TextStyle> = {
    marker: { color: c.muted },
    bold: sans(600),
    italic: { fontStyle: 'italic', color: c.merged },
    strike: { textDecorationLine: 'line-through' },
    code: { ...mono(400), fontSize: 14, backgroundColor: c.surface },
    link: { color: c.information, textDecorationLine: 'underline' },
    mention: { color: c.information },
    command: { color: c.primary },
  };
  const lineStyle: Partial<Record<ComposerLine['kind'], TextStyle>> = {
    quote: { color: c.muted },
    fence: { ...mono(400), fontSize: 14 },
    code: { ...mono(400), fontSize: 14 },
  };
  return <Text>
    {lines.map((line, index) => <Fragment key={index}>
      {index > 0 ? '\n' : null}
      <Text style={lineStyle[line.kind]}>
        {line.spans.map((span, at) => span.marks.length === 0
          ? <Fragment key={at}>{span.text}</Fragment>
          : <Text key={at} style={span.marks.map((mark) => markStyle[mark])}>{span.text}</Text>)}
      </Text>
    </Fragment>)}
  </Text>;
}
