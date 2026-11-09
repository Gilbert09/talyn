import type { ComponentProps } from 'react';
import { StyleSheet } from 'react-native';

import { Input } from '../../../components/UI';
import { type } from '../../../theme/tokens';

/**
 * A multiline field for long text such as instructions, a skill body or a
 * setup script. `code` uses the mono face, like the web editors. The text is
 * never corrected or capitalised, because it is often Markdown or shell.
 */
export function TextArea({ code = false, minHeight = 160, style, ...props }: ComponentProps<typeof Input> & { code?: boolean; minHeight?: number }) {
  return <Input multiline autoCapitalize="none" autoCorrect={false} spellCheck={!code} scrollEnabled={false}
    textAlignVertical="top" {...props} style={[styles.area, code && type.mono, { minHeight }, style]} />;
}

const styles = StyleSheet.create({ area: { paddingTop: 10 } });
