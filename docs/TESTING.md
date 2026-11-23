# Talyn Testing

This document is the single source of truth for *how we test*, *what we test*, and *when it runs*. For the commands to run while you work, see **Testing** in `CLAUDE.md`. That section wins when the two disagree.

## Principles

1. **Every change that ships gets type-checked and linted.** `npm run typecheck` and `npm run lint` run in CI on every push and PR. Non-negotiable.
2. **Favour integration-style tests over unit tests.** Talyn is mostly orchestration (routes → services → DB, webhooks → workers, WebSocket events). Pure unit tests rarely catch the failures that actually bite us; integration tests do.
3. **No mocking the DB.** Use a real in-memory Postgres — `createTestDb()` in `packages/backend/src/__tests__/helpers/testDb.ts`, which boots pglite and applies the migrations the journal lists. The suite relies on real Postgres semantics — jsonb, `timestamp with time zone`, partial indexes, RLS policies calling `auth.uid()`. The DB is one of the most bug-prone surfaces here; mocking it defeats the purpose. One known gap: pglite's drizzle session encodes a `Date` itself, so a raw `sql` fragment holding a `Date` passes locally and fails on postgres-js in production (see `loopQueryParams.test.ts`).
4. **Mock only I/O we can't control locally.** The GitHub API, the fleet (`helpers/fakeFleet.ts`), Slack (`helpers/fakeSlack.ts`), Redis and WebSocket clients. Wrap these in thin service interfaces so tests can inject stubs.
5. **CI is a backstop, not the inner loop.** The inner loop is `tsc --noEmit` plus the tests that cover what you touched. Do NOT run a whole package suite locally: the backend suite is about 7 minutes. CI runs everything on every push, and nothing blocks a deploy on it, so treat a red run as immediate work, because by the time it goes red the backend has already shipped.

## Stack

| Package                           | Runner                               | Run one file                                                |
| --------------------------------- | ------------------------------------ | ----------------------------------------------------------- |
| `packages/backend`                | **Vitest** (pglite per file)         | `npx vitest run <path/to/file.test.ts>`                     |
| `apps/desktop`                    | **Jest** + ts-jest, Testing Library  | `npx jest <pattern>`                                        |
| `apps/web`, `apps/admin`          | **Vitest** + Testing Library (jsdom) | `npx vitest run <pattern>` (admin: add `--root apps/admin`) |
| `apps/mobile`                     | **Jest** (`jest-expo`)               | `cd apps/mobile && npx jest --runInBand <pattern>`          |
| `packages/client`, `packages/cli` | **Vitest**                           | `npx vitest run`                                            |

Routes are tested with `helpers/invokeRoute.ts` and the other helpers in `packages/backend/src/__tests__/helpers/`. There is no Playwright suite. Mobile device flows are Maestro files in `apps/mobile/e2e/` (see its README).

## Layers

### 1. Typecheck + lint

- `npm run typecheck` and `npm run lint` at the repo root. Mobile: `npm run typecheck -w @talyn/mobile`.
- Run on every push and PR by `.github/workflows/test.yml` (Linux leg).

### 2. Backend unit + integration

Most of the suite, in `packages/backend/src/__tests__/`. Patterns worth copying:

- **Projection tests.** Assert a query's `.toSQL().sql` does not select a blob column (`projectionEgress.test.ts`), and pin SQL that replaces a JS helper to the helper's semantics with a pglite test.
- **Contract tests.** `openapi.contract.test.ts` fails when the public API declarations and `docs/api/openapi.json` disagree.
- **Concurrency designs.** Tests for a unique claim (`UNIQUE (workflow_id, delivery_id)`, `UNIQUE (loop_id, scheduled_for)`) race two callers against the real table.
- **Fleet-facing code** runs against `fakeFleet.ts`, which reproduces the exec frame contract. It does not run bash, because CI includes Windows.

### 3. Frontend tests

Keep this layer small. Components mostly read from a store and call typed API functions, so test where the logic lives: store reducers and patches (`apps/mobile/src/__tests__/workflowStore.test.ts`), model modules (`features/*/model.ts`), and screens with real conditional behaviour. Do not write 1:1 snapshot tests.

### 4. Release and device checks

Mobile release tooling has its own tests (`npm run mobile:test:release`) and the Maestro flows above. See [`MOBILE_RELEASE.md`](./MOBILE_RELEASE.md) and `MOBILE_RELEASE_CHECKLIST.md`.

## CI wiring (`.github/workflows/test.yml`)

- **`backend_tests`**: Ubuntu, the backend suite split into 4 shards (`--shard=N/4`), 30 minute limit each.
- **`test`**: runs after the backend shards, on macOS, Windows and Ubuntu. It builds `@talyn/shared`, `@talyn/client`, the backend, desktop, web and admin on every OS. The Linux leg also runs `typecheck`, `lint` and the desktop, web, admin and cli tests.
- **Mobile**: `.github/workflows/mobile.yml` runs the mobile checks and `npm run mobile:test`, and `mobile-update.yml` ships OTA updates from main.

## Keeping tests healthy

- **Every change to `packages/backend/src/services/*` adds or updates a test.** Enforced by review, not CI.
- **Every new route adds a test.** Same.
- **Every new migration is exercised by the suites that read its tables.** `createTestDb()` applies every migration, so a broken one fails everything.
- **Tests live next to the code in `__tests__/` folders**, mirroring the source tree.
- **A test that passes for the wrong reason is worse than none.** Do not call the seam directly when the point is that something calls it.
- **On a test failure, do not disable. Diagnose or delete with reason.** A silenced test is dead weight.
