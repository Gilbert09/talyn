import { SymbolView } from 'expo-symbols';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native';

import { AppText, Button } from '../../components/UI';
import { openExternal, safeExternalUrl } from '../../components/Workflow';
import { inlineText, parseMarkdown, type MdBlock, type MdImage, type MdInline } from '../../lib/markdown';
import { mono, radius, sans, type, useTheme, type Theme } from '../../theme/tokens';
import { useHighlighter } from './findHighlight';
import { FullScreenImage } from './FullScreenImage';

/** Characters per code `Text`. Very long single texts are slow to lay out on Android. */
const CODE_CHUNK = 4000;
/** The tallest an image thumbnail gets in the column. Tap it to see the full size. */
const IMAGE_MAX_HEIGHT = 280;

type Mark = (text: string, key?: string) => ReactNode;
const plain: Mark = (text) => text;

function renderInline(nodes: MdInline[], c: Theme, key = '', mark: Mark = plain): ReactNode[] {
  return nodes.map((node, index) => {
    const k = `${key}${index}`;
    switch (node.type) {
      case 'text': return mark(node.text, k);
      case 'br': return '\n';
      case 'strong': return <Text key={k} style={sans(600)}>{renderInline(node.children, c, `${k}.`, mark)}</Text>;
      case 'em': return <Text key={k} style={styles.em}>{renderInline(node.children, c, `${k}.`, mark)}</Text>;
      case 'del': return <Text key={k} style={styles.del}>{renderInline(node.children, c, `${k}.`, mark)}</Text>;
      case 'code': return <Text key={k} style={[styles.inlineCode, { backgroundColor: c.surface, color: c.text }]}>{mark(node.text, k)}</Text>;
      case 'link': {
        const url = safeExternalUrl(node.href);
        const children = renderInline(node.children, c, `${k}.`, mark);
        if (!url) return <Text key={k}>{children}</Text>;
        return <Text key={k} accessibilityRole="link" accessibilityLabel={`Open website: ${inlineText(node.children)}`}
          suppressHighlighting={false} onPress={() => openExternal(url)} style={{ color: c.information }}>{children}</Text>;
      }
    }
  });
}

function Paragraph({ children, style }: { children: MdInline[]; style?: TextStyle }) {
  const c = useTheme();
  const mark = useHighlighter();
  return <Text selectable style={[type.body, { color: c.text }, style]}>{renderInline(children, c, '', mark)}</Text>;
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const c = useTheme();
  const mark = useHighlighter();
  const chunks = Array.from({ length: Math.max(1, Math.ceil(text.length / CODE_CHUNK)) }, (_, index) => text.slice(index * CODE_CHUNK, (index + 1) * CODE_CHUNK));
  return <View accessibilityLabel={lang ? `${lang} code` : 'Code'} style={[styles.code, { backgroundColor: c.surface }]}>
    {lang ? <AppText variant="caption" tone="muted" style={styles.codeLang}>{lang}</AppText> : null}
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.codeScroll}>
      <View>{chunks.map((chunk, index) => <Text key={index} selectable style={[styles.codeText, { color: c.text }]}>{mark(chunk, String(index))}</Text>)}</View>
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

/** Width over height, kept in a range so a very wide or tall image still shows a usable box. */
const imageRatio = (width?: number, height?: number) => width && height ? Math.min(6, Math.max(0.2, width / height)) : null;

/** A markdown image: a thumbnail the width of the column. Tap it to see it full screen. */
function MarkdownImage({ block }: { block: MdImage }) {
  const c = useTheme();
  const [ratio, setRatio] = useState(() => imageRatio(block.width, block.height));
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [viewing, setViewing] = useState(false);
  const label = block.alt || 'Image';
  if (status === 'failed') return <Pressable accessibilityRole="link" accessibilityLabel={`Image unavailable: ${label}. Open in browser`}
    onPress={() => openExternal(block.src)} style={[styles.imageError, { borderColor: c.border, backgroundColor: c.surface }]}>
    <SymbolView name={{ ios: 'photo', android: 'image' }} size={16} tintColor={c.muted} />
    <AppText variant="meta" tone="muted" numberOfLines={2} style={styles.imageErrorText}>Image unavailable{block.alt ? `: ${block.alt}` : ''}</AppText>
  </Pressable>;
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={`Open image: ${label}`} onPress={() => setViewing(true)}
      style={({ pressed }) => [styles.image, { aspectRatio: ratio ?? 16 / 9, borderColor: c.border, backgroundColor: c.surface, opacity: pressed ? 0.8 : 1 }]}>
      <Image testID="markdown-image" source={{ uri: block.src }} resizeMode="contain" accessibilityIgnoresInvertColors style={styles.imageFill} onError={() => setStatus('failed')}
        onLoad={(event) => {
          setStatus('ready');
          const { width, height } = event.nativeEvent.source ?? {};
          setRatio((current) => current ?? imageRatio(width, height));
        }} />
      {status === 'loading' ? <View style={styles.imageOverlay}><ActivityIndicator size="small" color={c.muted} /></View> : null}
    </Pressable>
    {viewing ? <FullScreenImage source={{ uri: block.src }} label={label} onClose={() => setViewing(false)} zoomable
      footer={<Button title="Open in browser" variant="secondary" size="sm" icon={{ ios: 'safari', android: 'open_in_new' }} onPress={() => openExternal(block.src)} />} /> : null}
  </>;
}

function Blocks({ blocks, depth = 0 }: { blocks: MdBlock[]; depth?: number }) {
  const c = useTheme();
  const mark = useHighlighter();
  return <View style={styles.blocks}>{blocks.map((block, index) => {
    switch (block.type) {
      case 'paragraph': return <Paragraph key={index}>{block.children}</Paragraph>;
      case 'heading': return <Text key={index} accessibilityRole="header" selectable
        style={[block.depth <= 1 ? styles.h1 : block.depth === 2 ? styles.h2 : styles.h3, index > 0 && styles.headingAfter, { color: c.text }]}>{renderInline(block.children, c, '', mark)}</Text>;
      case 'code': return <CodeBlock key={index} lang={block.lang} text={block.text} />;
      case 'list': return <List key={index} block={block} depth={depth} />;
      case 'blockquote': return <View key={index} style={[styles.quote, { borderColor: c.border }]}><Blocks blocks={block.children} depth={depth + 1} /></View>;
      case 'table': return <Table key={index} block={block} />;
      case 'image': return <MarkdownImage key={index} block={block} />;
      case 'hr': return <View key={index} style={[styles.hr, { backgroundColor: c.border }]} />;
    }
  })}</View>;
}

/** Rendered markdown for agent and user messages. Links open through the external link confirmation. Images open full screen. */
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
  image: { width: '100%', minWidth: 160, maxHeight: IMAGE_MAX_HEIGHT, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  imageFill: { width: '100%', height: '100%' },
  imageOverlay: { ...StyleSheet.absoluteFill as object, alignItems: 'center', justifyContent: 'center' },
  imageError: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  imageErrorText: { flex: 1 },
});
