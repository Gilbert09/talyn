import { Suspense } from 'react';
import { useNavigationStore, type PrTab } from '../stores/navigation';
import { usePrBadgeCounts } from '../hooks/usePrBadgeCounts';
import { PR_PAGE_TABS, PR_TAB_LABEL } from '../lib/routeLabels';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { PageHeader } from '../components/ui/page-header';
import { MyPRsPanel } from '../components/panels/github/MyPRsPanel';
import { ReviewsPanel } from '../components/panels/github/ReviewsPanel';
import { MergeQueuePanel } from '../components/panels/github/MergeQueuePanel';
import { lazyWithReload } from '../lib/lazyWithReload';

const QueuePanel = lazyWithReload(() => import('../components/panels/QueuePanel').then((m) => ({ default: m.QueuePanel })));
const CodeReviewsPanel = lazyWithReload(() =>
  import('../components/panels/codeReview/CodeReviewsPanel').then((m) => ({ default: m.CodeReviewsPanel }))
);

export function PullRequestsView({ tab }: { tab: PrTab }) {
  const navigate = useNavigationStore((s) => s.navigate);
  const counts = usePrBadgeCounts();
  const inPage = PR_PAGE_TABS.includes(tab);
  const title = tab === 'reviews' ? 'Review requests' : tab === 'merge_queue' ? 'Merge queue' : 'Pull requests';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title={title} className="gap-4">
        {inPage && (
          <Tabs value={tab} onValueChange={(next) => navigate({ view: 'prs', tab: next as PrTab })}>
            <TabsList aria-label="Pull requests">
              {PR_PAGE_TABS.map((t) => (
                <TabsTrigger key={t} value={t} data-attr={`prs-tab-${t}`} className="gap-1.5">
                  {PR_TAB_LABEL[t]}
                  {counts[t] > 0 && <span className="tabular-nums text-muted-foreground">{counts[t]}</span>}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={null}>
          {tab === 'my_prs' && <MyPRsPanel />}
          {tab === 'reviews' && <ReviewsPanel />}
          {tab === 'code_reviews' && <CodeReviewsPanel />}
          {tab === 'merge_queue' && <MergeQueuePanel />}
          {tab === 'queue' && <QueuePanel />}
        </Suspense>
      </div>
    </div>
  );
}
