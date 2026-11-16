import { createContext, useContext, type ReactNode } from 'react';
import { Text } from 'react-native';

import { useTheme, withAlpha } from '../../theme/tokens';
import { highlightParts } from './transcriptFind';

/** The find query for the rows that match it. Empty in every other row. */
export const FindHighlightContext = createContext('');

export function useFindHighlight(): string {
  return useContext(FindHighlightContext);
}

/** Plain text with each occurrence of the query marked. Gives back the text as it is when nothing matches. */
export function useHighlighter(): (text: string, key?: string) => ReactNode {
  const query = useFindHighlight();
  const c = useTheme();
  if (!query) return (text) => text;
  const style = { backgroundColor: withAlpha(c.warning, c.mode === 'dark' ? 0.35 : 0.3) };
  return (text, key = '') => {
    const parts = highlightParts(text, query);
    if (parts.length === 1 && !parts[0].match) return text;
    return parts.map((part, index) => part.match ? <Text key={`${key}h${index}`} style={style}>{part.text}</Text> : part.text);
  };
}
