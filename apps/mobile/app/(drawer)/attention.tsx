import { Redirect } from 'expo-router';

import { pullsRoute } from '../../src/features/prs/lists';

/** The old Attention list link opens My PRs. */
export default function Screen() { return <Redirect href={pullsRoute('mine')} />; }
