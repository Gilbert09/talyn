import { PullRequestDetailScreen } from '../../src/features/prs/PullRequestDetailScreen';
import { pullsRoute } from '../../src/features/prs/lists';
import { DetailRoute } from '../../src/navigation/DetailRoute';

export default function Screen() { return <DetailRoute list={pullsRoute('mine')}><PullRequestDetailScreen /></DetailRoute>; }
