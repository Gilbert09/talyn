import { Stack, useLocalSearchParams, type Href } from 'expo-router';

import { McpServerEditorScreen } from '../../../src/features/mcp/McpServerEditor';
import { detailOptions } from '../../../src/features/more/Page';
import { DetailRoute } from '../../../src/navigation/DetailRoute';

export default function Screen() {
  const { id, catalog } = useLocalSearchParams<{ id: string; catalog?: string }>();
  const isNew = !id || id === 'new';
  return <DetailRoute list={'/settings/mcp' as Href}>
    <Stack.Screen options={detailOptions(isNew ? 'New MCP server' : 'MCP server')} />
    <McpServerEditorScreen id={id ?? 'new'} catalog={typeof catalog === 'string' ? catalog : undefined} />
  </DetailRoute>;
}
