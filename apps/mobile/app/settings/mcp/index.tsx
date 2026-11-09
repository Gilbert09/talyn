import { Stack } from 'expo-router';

import { McpServersScreen } from '../../../src/features/mcp/McpServersScreen';
import { detailOptions } from '../../../src/features/more/Page';
import { DetailRoute } from '../../../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/settings"><Stack.Screen options={detailOptions('MCP servers')} /><McpServersScreen /></DetailRoute>;
}
