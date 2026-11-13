import { SymbolView } from 'expo-symbols';
import { memo, useMemo, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native';

import { AppText } from '../../components/UI';
import { openExternal, safeExternalUrl } from '../../components/Workflow';
import { inlineText, parseMarkdown, type MdBlock, type MdInline } from '../../lib/markdown';
import { mono, radius, sans, type, useTheme, type Theme } from '../../theme/tokens';

/** Characters per code `Text`. Very long single texts are slow to lay out on Android. */
const CODE_CHUNK = 4000;

function renderInline(nodes: MdInline[], c: Theme, key = ''): ReactNode[] {
  return nodes.map((node, index) => {
    const k = `${key}${index}`;
    switch (node.type) {
      case 'text': return node.text;
      case 'br': return '\n';
      case 'strong': return <Text key={k} style={sans(600)}>{renderInline(node.children, c, `${k}.`)}</Text>;
      case 'em': return <Text key={k} style={styles.em}>{renderInline(node.children, c, `${k}.`)}</Text>;
      case 'del': return <Text key={k} style={styles.del}>{renderInline(node.children, c, `${k}.`)}</Text>;
      case 'code': return <Text key={k} style={[styles.inlineCode, { backgroundColor: c.surface, color: c.text }]}>{node.text}</Text>;
      case 'link': {
        const url = safeExternalUrl(node.href);
        const children = renderInline(node.children, c, `${k}.`);
        if (!url) return <Text key={k}>{children}</Text>;
        return <Text key={k} accessibilityRole="link" accessibilityLabel={`Open website: ${inlineText(node.children)}`}
          suppressHighlighting={false} onPress={() => openExternal(url)} style={{ color: c.information }}>{children}</Text>;
      }
    }
  });
}

function Paragraph({ children, style }: { children: MdInline[]; style?: TextStyle }) {
  const c = useTheme();
  return <Text selectable style={[type.body, { color: c.text }, style]}>{renderInline(children, c)}</Text>;
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const c = useTheme();
  const chunks = Array.from({ length: Math.max(1, Math.ceil(text.length / CODE_CHUNK)) }, (_, index) => text.slice(index * CODE_CHUNK, (index + 1) * CODE_CHUNK));
  return <View accessibilityLabel={lang ? `${lang} code` : 'Code'} style={[styles.code, { backgroundColor: c.surface }]}>
    {lang ? <AppText variant="caption" tone="muted" style={styles.codeLang}>{lang}</AppText> : null}
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.codeScroll}>
      <View>{chunks.map((chunk, index) => <Text key={index} selectable style={[styles.codeText, { color: c.text }]}>{chunk}</Text>)}</View>
    </ScrollView>
  </View>;
}

function List({ block, depth }: { block: Extract<MdBlock, { type: 'list' }>; depth: number }) {
  const c = useTheme();
  return <View style={styles.list}>{block.items.map((item, index) => <View key={index} style={styles.item}>
    <View style={styles.marker}>
      {item.checked !== null
        ? <SymbolView accessibilityLabel={item.checked ? 'Done' : 'Not done'} size={15} tintColor={c.muted}
          name={item.checked ? { ios: 'checkmark.square', android: 'check_box' } : { ios: 'square', android: 'check_box_outline_blank' }} />
        : <Text style={[type.body, { color: c.muted }]}>{block.ordered ? `${block.start + index}.` : depth % 2 ? '◦' : '•'}</Text>}
    </View>
    <View style={styles.itemBody}><Blocks blocks={item.children} depth={depth + 1} /></View>
  </View>)}</View>;
}

function Table({ block }: { block: Extract<MdBlock, { type: 'table' }> }) {
  const c = useTheme();
  const widths = block.header.map((cell, column) => {
    const longest = Math.max(inlineText(cell).length, ...block.rows.map((row) => inlineText(row[column] ?? []).length));
    return Math.min(240, Math.max(64, longest * 7.5 + 20));
  });
  const row = (cells: MdInline[][], header: boolean, key: string) => <View key={key} style={[styles.tableRow, { borderColor: c.border }]}>
    {widths.map((width, column) => <View key={column} style={[styles.cell, { width, borderColor: c.border, backgroundColor: header ? c.paper : 'transparent' }]}>
      <Paragraph style={{ ...type.meta, ...(header ? sans(600) : null), textAlign: block.align[column] ?? 'left' }}>{cells[column] ?? []}</Paragraph>
    </View>)}
  </View>;
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityLabel="Table">
    <View style={[styles.table, { borderColor: c.border }]}>
      {row(block.header, true, 'header')}
      {block.rows.map((cells, index) => row(cells, false, String(index)))}
    </View>
  </ScrollView>;
}

function Blocks({ blocks, depth = 0 }: { blocks: MdBlock[]; depth?: number }) {
  const c = useTheme();
  return <View style={styles.blocks}>{blocks.map((block, index) => {
    switch (block.type) {
      case 'paragraph': return <Paragraph key={index}>{block.children}</Paragraph>;
      case 'heading': return <Text key={index} accessibilityRole="header" selectable
        style={[block.depth <= 1 ? styles.h1 : block.depth === 2 ? styles.h2 : styles.h3, index > 0 && styles.headingAfter, { color: c.text }]}>{renderInline(block.children, c)}</Text>;
      case 'code': return <CodeBlock key={index} lang={block.lang} text={block.text} />;
      case 'list': return <List key={index} block={block} depth={depth} />;
      case 'blockquote': return <View key={index} style={[styles.quote, { borderColor: c.border }]}><Blocks blocks={block.children} depth={depth + 1} /></View>;
      case 'table': return <Table key={index} block={block} />;
      case 'hr': return <View key={index} style={[styles.hr, { backgroundColor: c.border }]} />;
    }
  })}</View>;
}

/** Rendered markdown for agent and user messages. Links open through the external link confirmation. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const doc = useMemo(() => parseMarkdown(text), [text]);
  return <View>
    <Blocks blocks={doc.blocks} />
    {doc.truncated ? <AppText variant="meta" tone="muted" style={{ marginTop: 6 }}>Long text is limited in this view.</AppText> : null}
  </View>;
});

const styles = StyleSheet.create({
  blocks: { gap: 8 },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through' },
  inlineCode: { ...mono(400), fontSize: 13 },
  code: { borderRadius: radius.sm, overflow: 'hidden' },
  codeLang: { paddingHorizontal: 10, paddingTop: 6 },
  codeScroll: { paddingHorizontal: 10, paddingVertical: 8 },
  codeText: { ...mono(400), fontSize: 12.5, lineHeight: 18 },
  list: { gap: 4 },
  item: { flexDirection: 'row', gap: 6 },
  marker: { minWidth: 18, alignItems: 'flex-end', paddingTop: 2 },
  itemBody: { flex: 1, minWidth: 0 },
  quote: { borderLeftWidth: 2, paddingLeft: 10, opacity: 0.85 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, overflow: 'hidden' },
  tableRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  cell: { paddingHorizontal: 8, paddingVertical: 6, borderRightWidth: StyleSheet.hairlineWidth },
  h1: { fontSize: 18, lineHeight: 24, ...sans(700) },
  h2: { fontSize: 16, lineHeight: 22, ...sans(600) },
  h3: { fontSize: 15, lineHeight: 21, ...sans(600) },
  // A heading starts a new section. Give it more space above than below.
  headingAfter: { marginTop: 8 },
  hr: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
});
