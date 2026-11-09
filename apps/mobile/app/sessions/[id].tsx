import { WorkbenchDetailScreen } from '../../src/features/sessions/WorkbenchDetailScreen';
import { DetailRoute } from '../../src/navigation/DetailRoute';

export default function Screen() { return <DetailRoute list="/sessions"><WorkbenchDetailScreen kind="session" /></DetailRoute>; }
