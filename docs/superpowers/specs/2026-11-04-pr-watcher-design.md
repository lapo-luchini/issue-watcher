# Watcher — centralized tracker for open-source PRs, issues and bugs

Date: 2026-11-04 · Status: approved design, pending implementation plan

## 1. Goal

Track, in one place, all PRs/MRs, issues and bugs I am involved in across many forges,
and surface **only meaningful activity** ("signal"), ignoring low-value noise such as
"+1", emoji-only comments, bot chatter and "any update?" pings.

### Supported platforms (v1)

All adapters are **multi-instance** (one adapter type, many configured servers):

| Adapter  | Instances (examples)                                   |
|----------|--------------------------------------------------------|
| github   | github.com                                             |
| gitlab   | gitlab.com, invent.kde.org, other self-hosted GitLab   |
| forgejo  | codeberg.org, other self-hosted Forgejo/Gitea          |
| bugzilla | bugs.freebsd.org, bugs.kde.org, bugzilla.mozilla.org   |
| manual   | any URL; listed in the UI, never polled                |

### Non-goals (v1)

Phabricator (reviews.freebsd.org), mailing-list polling, push notifications, built-in
authentication, MCP server, LLM-based filtering. The design keeps seams for all of them
(adapter interface, `api.ts`, pluggable filter) but none are built now.

## 2. Runtime and stack

- **Bun** is the runtime (available natively on Linux and FreeBSD). Backend is
  TypeScript executed directly by Bun, no build step.
  - `bun:sqlite` for the cache, `Bun.serve` for HTTP, `bun test` for tests.
  - `yaml` npm package (not `Bun.YAML`) for the intent file, because rewriting it must
    preserve comments and ordering.
- **Frontend**: Vue 3, **no build script**. `Bun.serve` serves `web/index.html` as an
  HTML import (`import index from "../web/index.html"`), and Bun transpiles and bundles
  the frontend TypeScript on the fly. The whole project is therefore just
  `bun install` + `bun run`, with no Vite and no separate build step.
  - Components are `.ts` modules exporting ``{ props, setup, template: `...` }``; templates
    are compiled at runtime by Vue's full build (`vue/dist/vue.esm-bundler.js`, aliased
    as `vue`), since Bun does not compile `.vue` SFCs.
  - Accepted limits: no `.vue` SFCs, no `<style scoped>` (one plain stylesheet with
    BEM-style class names), template errors surface at runtime in the browser console
    rather than at compile time, ~50 KB extra for the runtime template compiler, no HMR.
  - The first implementation task verifies Bun's HTML-import bundling with Vue
    (runtime-compiler alias included) before building on it.
  - Escape hatch if the UI grows large: move to Vite + SFCs; component logic carries
    over almost unchanged.
- TypeScript style: plain and readable for a JS developer — interfaces, type annotations,
  string-literal unions; no enums, decorators or advanced generics.

## 3. Architecture

```
watcher/
  data/config.yaml       in git: instances + filter tuning (no secrets)
  data/items.yaml        in git: user intent (priority, mute, notes, manual items)
  .env                   git-ignored: tokens
  var/cache.sqlite       git-ignored: snapshots, events, seen-state, poll runs
  src/core/
    model.ts             Item, ItemRef, Snapshot, NormalizedEvent types
    config.ts            load config.yaml + resolve tokens from env
    intent.ts            read/write items.yaml, git commit on change
    store.ts             SQLite cache access
    filter.ts            signal/noise classification (pluggable function)
    http.ts              JSON fetch: timeout, retry, gone/rate-limit errors, pagination
    summary.ts           one-line event summaries
    poller.ts            discover → fetch → diff → filter → store
    api.ts               query/command API shared by all front ends
  src/adapters/
    github.ts gitlab.ts forgejo.ts bugzilla.ts
  src/cli.ts             `watcher poll`, `watcher serve`, `watcher refilter`
  src/server.ts          HTTP JSON API + SPA (served via Bun HTML import)
  web/                   Vue 3 SPA: index.html, main.ts, components/*.ts, style.css
  test/                  bun tests + fixtures/<forge>/
```

**Front ends** (CLI, HTTP server, and in the future an MCP server) are thin wrappers over
`api.ts`. Nothing requires a long-running process: polling is a one-shot command run by
cron / a systemd timer (suggested every 20 min) or by the UI "Poll now" button; the UI
server can run permanently or on demand.

### Adapter contract

Adapters only talk to the forge and normalize; they know nothing about noise, diffing or
storage.

```ts
interface Adapter {
  // Parse a web URL belonging to this instance (items added by hand, UI validation).
  refFromUrl(url: string): ItemRef | null;
  // Items involving me that changed since `since` (incremental discovery).
  // `since` null = first run: open items only.
  discover(since: Date | null): Promise<ItemRef[]>;
  // Full current view of one item, with its complete normalized timeline.
  fetch(ref: ItemRef): Promise<Snapshot>;
}

interface ItemRef { url: string; instance: string; kind: "pr" | "issue" | "bug"; }

interface Snapshot {
  ref: ItemRef;
  repo: string;            // e.g. "foo/bar", "sysutils/x" (Bugzilla: product/component)
  title: string;
  state: string;           // normalized: open | merged | closed | gone, plus forge detail
  stateDetail?: string;    // e.g. Bugzilla "In Progress", "Closed/FIXED"
  ciState?: "success" | "failure" | "pending" | null;
  hasConflicts?: boolean;
  authoredByMe: boolean;
  labels: string[];
  events: NormalizedEvent[];
}

interface NormalizedEvent {
  key: string;             // stable forge-native id, unique within the item
  kind: "comment" | "review" | "state" | "label" | "milestone" | "push" | "ci"
      | "conflict" | "flag" | "attachment" | "assign" | "mention" | "review_request";
  actor: string;
  actorRole: "me" | "maintainer" | "contributor" | "bot" | "unknown";
  at: Date;
  body?: string;           // comment/review text
  details?: Record<string, unknown>; // e.g. {from, to}, {flag, status}
}
```

### Discovery strategy: search-driven incremental polling

Per instance, one "involving me, updated since cursor" query, then full fetch only of
returned items:

- **GitHub**: `search/issues?q=involves:USER updated:>T` (covers authored, assigned,
  mentioned, commented). Plus, on every incremental poll, `/notifications?all=true&since=T`
  (one cheap call), used only for discovery of issues I merely subscribed to; skipped when
  the token cannot read notifications (fine-grained tokens).
- **GitLab**: `/issues` and `/merge_requests` with `scope=all`, author / assignee /
  reviewer filters, `updated_after=T`.
- **Forgejo**: `/repos/issues/search` with `since=T` and created / assigned / mentioned.
- **Bugzilla**: `/rest/bug?last_change_time=T` matching my email as reporter, assignee
  or CC; item fetch uses `/rest/bug/:id`, `/comment`, `/history`, `/attachment`.

Known items also include everything in `items.yaml` (non-manual), which are fetched when
discovery reports them or on first sight.

## 4. Data model

### `data/config.yaml` (in git)

```yaml
instances:
  - id: github
    type: github
    url: https://api.github.com
    user: lapo
    token_env: GITHUB_TOKEN
  - id: freebsd-bz
    type: bugzilla
    url: https://bugs.freebsd.org/bugzilla
    user: lapo@example.org
    token_env: FREEBSD_BZ_KEY
  # …

filter:
  noise_patterns: ['^\+1$', '^me too', '^same here', '^any update', '^bump$']
  min_comment_length: 20
  bot_allowlist: []
```

### `data/items.yaml` (in git) — user intent only, keyed by canonical URL

```yaml
items:
  - url: https://github.com/foo/bar/pull/42
    priority: important
    note: waiting for the 1.4 branch
  - url: https://github.com/x/y/issues/7
    muted: true
  - url: https://lists.example.org/archives/foo-devel/2026-10/msg00012.html
    manual: true
    title: "[PATCH] foo: fix bar on FreeBSD"
```

- Auto-discovered items appear in this file only once the user changes something.
- **Priority has two levels**: `important` and `normal`.
  Default: PRs/MRs I authored → `important`; everything else → `normal`.
- Writes go through the `yaml` Document API to preserve comments and ordering, followed by
  one `git commit` per change (message like `watcher: mark foo/bar#42 important`), using the
  repository's configured identity. A failed commit leaves the file written and is reported
  to the UI as a warning.

### `var/cache.sqlite` (git-ignored, rebuildable)

- `items`: url (PK), id (short hash of url), instance, kind, repo, title, state,
  state_detail, ci_state, authored_by_me, labels_json, last_signal_at, last_signal_summary,
  seen_at, baseline_at, fetched_at, snapshot_json
- `events`: item_url, event_key, kind, actor, actor_role, at, detected_at, excerpt,
  details_json, is_signal, reason — unique (item_url, event_key)
- `poll_runs`: instance, started_at, finished_at, cursor, error
- `locks`: name (PK), holder, acquired_at — prevents overlapping polls

Rules:

- **All events are stored**, noise included, with the filter verdict and `reason`
  (`signal:review`, `noise:+1`, `noise:bot`, …). `watcher refilter` re-evaluates stored
  events after filter changes without re-polling.
- **Baseline**: the first time an item is seen, its existing events are stored with
  `detected_at = baseline_at` and never make the item unread. A fresh cache therefore
  starts quiet.
- **Detection time**: `last_signal_at` is when *we detected* the latest signal (local
  clock), not the forge timestamp, so unread compares local time with local time and a
  late-arriving event with an old timestamp (e.g. an old commit pushed now) still counts.
- **Unread** ⇔ `last_signal_at > seen_at` (or `seen_at` null and any `last_signal_at`).
- **Own activity**: my own event newer than the latest new signal sets `seen_at`.
- **CI**: `ci_state` keeps the last *settled* result (`pending` does not overwrite it); a
  first green result is not signal, a first red one or any later change is.
- **Cursor**: per instance; the next query uses `cursor − 5 min` overlap; dedup by
  `event_key` absorbs the overlap.

## 5. Signal filter

Pure function: `(event, item, config) → { isSignal: boolean, reason: string }`.
Replaceable/augmentable later (e.g. by an LLM classifier).

**Always signal** (any priority):
- State change: merged, closed, reopened; Bugzilla status/resolution change.
- Review submitted (approved, changes requested, or commented with a body).
- Label or milestone change by a maintainer.
- I am mentioned, assigned, or requested as reviewer.
- Bugzilla flag changes (e.g. `maintainer-approval`, `mfc-stable*`) and attachment
  obsoletion/new patches.
- Item became `gone` (404 / private / deleted).

**Signal only on `important` items** (stored as noise with reason `low-priority:*` on
`normal` items):
- CI status change on the PR head commit (to failure, or back to success).
- Commits pushed to my PR by someone else.
- Merge conflict appeared.

**Comments** are signal unless one of these applies:
- Author is me → not signal; instead marks the item seen at that time.
- Author is a bot (`[bot]` suffix, known bot names such as stale bots, dependabot, codecov,
  CI bots) and not in `bot_allowlist`.
- Body is only emoji/reactions, or — when at most 100 characters after normalization —
  matches a `noise_patterns` entry (case- and punctuation-insensitive), so a long,
  substantive comment starting with "Any update" still counts.
- Body is shorter than `min_comment_length` **and** the author is not a maintainer.

Comments by maintainers / members / collaborators (`actorRole: maintainer`) always count
as signal, even when short ("LGTM", "ping").

Muted items are polled and stored but hidden in the UI unless "show muted" is on.

## 6. UI and HTTP API

### UI (single page)

A table, important items pinned on top, each group sorted by most recent signal.
Columns: unread dot · importance star · forge+repo · title (link) · state (incl. CI) ·
latest signal summary · relative time.

- Opening the item link or clicking the row marks it seen; "mark all seen" button.
- Star toggles importance; row menu: mute, edit note, copy URL.
- Expanding a row shows its signal events (newest first, with excerpts); a "show filtered"
  toggle also shows noise events greyed with their reason.
- Top bar: filters (unread only, important only, show muted, per forge), "add manual item"
  (paste URL), **Poll now**, per-instance status (last success / error).

### HTTP API (JSON)

```
GET    /api/items                    list rows; filters as query params
GET    /api/items/:id/events?noise=1 event history for one item
PATCH  /api/items/:id                {priority?, muted?, note?} → items.yaml + commit
POST   /api/items                    {url, title?} add item → items.yaml + commit
POST   /api/items/:id/seen           mark seen (cache only)
POST   /api/seen                     mark all seen
POST   /api/poll                     start a poll asynchronously; 409 if one is running
GET    /api/status                   per-instance last poll result
```

### Security

`Bun.serve` binds to `127.0.0.1` by default. The server holds tokens and writes to git,
so there is no built-in auth; exposing it (`WATCHER_HOST`) must be done behind a reverse
proxy with authentication, which is documented in the README.

## 7. Error handling and rate limits

- **Per-instance isolation**: one failing instance (down, bad token) does not affect the
  others; its error is recorded in `poll_runs` and shown in the UI.
- **Cursor advances only on full success** of an instance's run; failed item fetches cause
  re-discovery next time (dedup keeps this harmless).
- Missing token in `.env` → instance disabled with a clear status message.
- HTTP: 30 s timeout; retry transient failures (5xx, network) up to 3 times with
  exponential backoff.
- **GitHub**: on a rate-limit response (403 with `X-RateLimit-Remaining: 0` or
  `Retry-After`, or 429), stop the instance cleanly without advancing the cursor and report
  the reset time. Search (30/min) is used once per run. No ETag conditional requests:
  discovery only returns changed items, so a `304` would almost never happen.
- Other forges: at most 4 concurrent requests per instance, same backoff policy.

## 8. CLI

```
watcher poll [--instance ID] [--dry-run]   one-shot poll; --dry-run prints, writes nothing
watcher list [--all] [--muted]             unread items (usable before the web UI exists)
watcher seen [URL...]                      mark items seen (no URL: all)
watcher serve [--port N]                   HTTP API + SPA
watcher refilter                           re-run filter over stored events
```

## 9. Testing (`bun test`)

- **Filter**: table-driven cases per rule (+1, emoji-only, short non-maintainer, short
  maintainer "LGTM", bot vs allowlisted bot, own comment, priority-dependent kinds).
- **Poller core**: diff, baseline, cursor overlap/dedup, unread computation — against an
  in-memory SQLite and a fake adapter.
- **Intent**: `items.yaml` round-trip preserving comments/order; commit tested in a temp
  git repo.
- **Adapters**: sanitized recorded API responses in `test/fixtures/<forge>/`, served via a
  mocked `fetch`; a shared contract test every adapter must pass (valid refs, stable
  `event_key`s, correct `actorRole` mapping).
- **Live smoke**: `watcher poll --dry-run --instance X` to validate a new instance/token.
- **UI**: no automated tests in v1.

## 10. Future seams (not built in v1)

- **MCP server / personal-secretary integration**: another thin front end over `api.ts`
  (`listItems`, `getUpdates(since)`, `setPriority`, `markSeen`).
- **LLM filter**: replace or back up `filter.ts`; `refilter` re-evaluates history.
- **More adapters** (Phabricator, Sourcehut, Gerrit): implement `Adapter`.
