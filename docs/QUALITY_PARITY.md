# Quality Parity — closing the gap to Conductor

A working assessment of where the Talyn desktop experience trails a
polished agent IDE ([Conductor](https://www.conductor.build/)), and the
plan to close it. Started Session 24. The recurring complaint that
"everything feels a little buggy" is mostly **desktop polish debt**, not
architecture — the backend is well-tested and solid; the
quality frontier is the renderer.

## The three things that make Conductor feel "solid"

1. **No jank** — the transcript stays responsive while an agent streams.
2. **A real diff + PR review surface inside the app** — file-by-file
   diffs, PR status, a Merge button — not a hand-off to github.com.
3. **High-fidelity transcript rendering** — markdown, collapsible tool
   calls, inline diffs.

Talyn already had good bones for (3) (collapsible tool calls with smart
summaries, permission cards, live streaming). Sessions 24+ attack (1) and
(2) and finish (3).

## Done (Session 24)

- **Feed performance.** `task:event` WS broadcasts are coalesced per task
  and flushed once per frame (`hooks/useApi.ts`); `BlockView` is memoized
  with a render-affecting signature (`components/terminal/AgentConversation.tsx`).
  Was O(n²) work + a re-render storm per turn.
- **PR file diffs inline.** `GET /pull-requests/:id/files` +
  `PRDetailSheet` Files tab renders each file's diff via `@pierre/diffs`.
- **In-app merge.** `POST /pull-requests/:id/merge` + green Merge button
  (mergeable PRs only, two-step confirm). Reverses the Phase-7
  deep-link-only stance for merge specifically.
- **Per-check breakdown.** `checkContexts` on the live PR detail fetch →
  per-check rows in the Checks tab.
- **Richer markdown** in the agent feed (headings, lists, blockquotes,
  bold/italic/links).

## Done (Session 25 — GitHub page)

- **Real Refresh.** Forces a GitHub poll (`repositories.forcePoll`) then
  re-reads the cache, instead of only re-reading the local DB.
- **Connect-GitHub empty state** when the workspace isn't connected
  (distinct from connected-but-empty).
- ~~**Unread dots.**~~ Shipped here off unread `inbox_items`, then
  removed in Session 43 with the Inbox (`inbox_items`, `unreadCount`,
  and `POST /pull-requests/:id/seen` are all gone). If per-row "new
  activity" indicators come back they need a new data source.
- **Row actions.** Hover-revealed squash-merge (mergeable only, confirm)
  and create-task (`pr_response`) per row.
- **Review-requested PRs.** Monitor now watches PRs awaiting the user's
  review, not just authored ones (`review_requested` column, migration
  0014). `relationship` list filter + Mine/Review/All pills + "Review"
  badge. `sweepClosed` guarded so reviewed-but-still-open PRs aren't
  wrongly closed.
- **Table polish.** Sortable Updated column, filter-pill counts,
  keyboard-navigable rows, Task badge deep-links to its task.

## Backlog (prioritized)

### Tier 1 — felt quality
- [ ] **Desktop test coverage.** Today: 3 trivial test files vs. 240+
  backend tests. UI regressions go uncaught — this is *why* polish
  decays. Add component/hook tests (`AgentConversation` block rendering,
  `useApi` task:event coalescing, `PRDetailSheet` tabs) and a Playwright
  E2E pass over the golden flows. (Plan in `TESTING.md` Phases D/E.)
- [ ] **Profile the task list** under many concurrent running tasks; the
  per-frame coalescing fixed the detail view, verify the list is clean.

### Tier 2 — GitHub depth
- [ ] **Review/comment composition** from the desktop (currently
  deep-links). Needs a write path + a decision on how much of GitHub's
  review model to mirror.
- [ ] **Side-by-side diff option** in the PR Files tab (currently
  unified). `@pierre/diffs` supports `diffStyle: 'split'`.
- [ ] **Merge method picker** (merge/squash/rebase) — backend already
  accepts `method`; UI hardcodes squash.

### Tier 3 — layout / composer
- [ ] **Composer model picker.** Conductor shows the model in the
  composer. **Blocked on backend**: model is fixed at task creation; the
  `/input` and `/continue` paths would need to accept a model override.
  Deliberately *not* shipping a non-functional picker — that's the
  placeholder feeling we're removing.
- [ ] **Composer attachments.** Large: needs a file-upload pipeline to
  the cloud provider's run API (where one exists). Deferred.
- [ ] **True simultaneous 3-pane layout** (feed + diff + terminal at
  once, like the screenshot). Today task→PR continuity goes through the
  `PRDetailSheet` overlay, which is functional; a side-by-side pane is a
  larger layout refactor with marginal benefit over the overlay.

## Decision log

- **Session 24 — merge is an in-app write.** Phase 7 (Session 23) made
  *all* PR writes deep-links to github.com. We reverse that for **merge
  only**: it's the highest-value parity action and is gated (mergeable
  PRs, explicit confirm). Reads (files, checks) and merge now go through
  `/pull-requests`; review/comment composition still deep-links.
