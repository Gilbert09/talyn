import { lazy, Suspense, useEffect } from 'react';
import { codeReviewOffered } from '@talyn/shared';
import { useWorkspaceStore } from '../stores/workspace';
import { useNavigationStore, type PrTab } from '../stores/navigation';
import { usePrBadgeCounts } from '../hooks/usePrBadgeCounts';
import { PR_PAGE_TABS, PR_TAB_LABEL } from '../lib/routeLabels';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { PageHeader } from '../components/ui/page-header';
import { MyPRsPanel } from '../components/panels/github/MyPRsPanel';
import { ReviewsPanel } from '../components/panels/github/ReviewsPanel';
import { MergeQueuePanel } from '../components/panels/github/MergeQueuePanel';

const QueuePanel = lazy(() => import('../components/panels/QueuePanel').then((m) => ({ default: m.QueuePanel })));
const CodeReviewsPanel = lazy(() =>
  import('../components/panels/codeReview/CodeReviewsPanel').then((m) => ({ default: m.CodeReviewsPanel }))
);

export function PullRequestsView({ tab }: { tab: PrTab }) {
  const features = useWorkspaceStore((s) => s.features);
  const navigate = useNavigationStore((s) => s.navigate);
  const codeReview = codeReviewOffered(features);
  const counts = usePrBadgeCounts(codeReview);
  const tabs = PR_PAGE_TABS.filter((t) => t !== 'code_reviews' || codeReview);
  const inPage = PR_PAGE_TABS.includes(tab);
  const title = tab === 'reviews' ? 'Review requests' : tab === 'merge_queue' ? 'Merge queue' : 'Pull requests';
  const refused = tab === 'code_reviews' && features !== null && !codeReview;
  useEffect(() => {
    if (refused) navigate({ view: 'prs', tab: 'my_prs' }, { replace: true });
  }, [refused, navigate]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title={title} className="gap-4">
        {inPage && (
          <Tabs value={tab} onValueChange={(next) => navigate({ view: 'prs', tab: next as PrTab })}>
            <TabsList aria-label="Pull requests">
              {tabs.map((t) => (
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
          {tab === 'code_reviews' && codeReview && <CodeReviewsPanel />}
          {tab === 'merge_queue' && <MergeQueuePanel />}
          {tab === 'queue' && <QueuePanel />}
        </Suspense>
      </div>
    </div>
  );
}
