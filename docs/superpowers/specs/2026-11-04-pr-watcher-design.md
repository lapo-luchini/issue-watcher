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
| radicle  | seed.radicle.garden (listed repos), my own radicle-httpd node |
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
  // `since` null = first run: open items only. `known`: this instance's cached items that
  // may still change (open, or fetched in the last 30 days), for forges whose search cannot
  // find items I only commented on (GitLab checks them for updates in batches).
  discover(since: Date | null, known: ItemRef[]): Promise<ItemRef[]>;
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
  hasConflicts?: boolean | null; // null: unknown (forge still computing it)
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
  mentioned, commented), plus the same query with `review-requested:USER` and
  `reviewed-by:USER` (which `involves:` does not cover), deduplicated by URL. Plus, on every incremental poll, `/notifications?all=true&since=T`
  (one cheap call), used only for discovery of issues I merely subscribed to; skipped when
  the token cannot read notifications (fine-grained tokens).
- **GitLab** (token required: these endpoints refuse anonymous requests):
  `/merge_requests` (author / assignee / reviewer) and `/issues` (author / assignee) with
  `scope=all` and `updated_after=T` (first run: `state=opened`); to-dos (mentions, direct
  addressing; first run: pending ones, later: the newest page of pending and done ones);
  my "commented" contribution events (first run: the last 90 days, whatever the state);
  and the `known` items, checked per project with `iids[]` + `updated_after=T`, since
  GitLab has no "involves" filter. Item fetch: the MR/issue, its notes (comments, and
  system notes for pushes, approvals, review requests and assignments), and its
  resource state / label / milestone events. Maintainer = project member with Developer
  access or more.
- **Forgejo** (token required: anonymous searches ignore the "me" flags):
  `/repos/issues/search` with `since=T` (first run: `state=open`) and each of created /
  assigned / mentioned / review_requested / reviewed, plus `/notifications` (also on the
  first run, open items only), which covers items I commented on; skipped when the token
  cannot read notifications. Item fetch: issue, timeline, PR, reviews, combined commit
  status. Maintainer = repo owner, a user with write access (the repo's assignees list), or
  the author of an official review.
- **Bugzilla** (API key optional; sent as `api_key` in the query, since Bugzilla 5.0 ignores
  the header, and kept out of logged URLs): `/rest/bug` with buglist-style email criteria
  (my login as reporter, assignee, CC, QA contact or commenter) and `last_change_time=T`
  (first run: `resolution=---`); item fetch uses `/rest/bug/:id`, `/comment`, `/history`,
  `/attachment`. Maintainer = the bug's assignee, or an email in the instance's
  `maintainer_domains`. An assignee change is reported (someone took the bug). A bug I may
  no longer see (401, code 102) counts as gone.
- **Radicle** (no token; `url` is a `radicle-httpd` API, a public seed with a configured
  `repos:` list, or my own node, which watches every repo it seeds): Radicle has no
  "involving me" search, no "updated since" filter, no history of state/label/assignee
  changes, and timestamps come from the authors' clocks. So every poll lists the open issues
  and open/draft patches of each watched repo (the listings also serve as the fetched data),
  keeps those involving any of my identities (`user` may be a list of DIDs) — or all of them
  on repos where I am a delegate, whose incoming patches are important by default — and
  re-fetches known items the cache has as open but that are no longer listed as open, to see
  them closed, merged or archived. Revisions are pushes, reviews carry their verdict, merges
  their merger; a closed/archived state and my assignment are one event each, timed by the
  item's latest activity. Maintainer = repo delegate. Comments on an already closed item are
  not seen unless it is reopened. Links point to `app.radicle.xyz/nodes/<host>` unless `web`
  is set.

Known items also include everything in `items.yaml` (non-manual), which are fetched when
discovery reports them or on first sight.

## 4. Data model

### `data/config.yaml` (in git)

```yaml
# Optional: my commit emails, to recognize my commits not linked to `user`.
emails: [lapo@example.org]

instances:
  - id: github
    type: github
    url: https://api.github.com
    user: lapo
    token_env: GITHUB_TOKEN
    # emails: [lapo@work.example]  # optional: replaces the top-level list for this instance
  - id: freebsd-bz
    type: bugzilla
    url: https://bugs.freebsd.org/bugzilla
    user: lapo@example.org
    token_env: FREEBSD_BZ_KEY
    maintainer_domains: [freebsd.org]  # Bugzilla: committers' comments count as maintainer's
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
- On load, non-manual URLs are canonicalized by the instances' adapters (so a URL copied
  from the browser, with a trailing slash, a PR tab like `/files`, a query or a
  `#fragment`, still matches); entries no configured instance recognizes are ignored with
  a warning. Every `url` must be a valid absolute URL.
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
  details_json, is_signal, reason, is_baseline — unique (item_url, event_key)
- `poll_runs`: instance, started_at, finished_at, cursor, error
- `locks`: name (PK), holder, acquired_at — prevents overlapping polls
- `retry`: instance, item_url, kind, attempts, last_error, first_since — PK (instance,
  item_url); items whose fetch failed, fetched again on the next runs. `first_since` is the
  discovery cursor of the run where the fetch first failed (null on an instance's first
  run): if the item is a first sighting when it finally succeeds, its baseline is judged
  against that, so activity between the failure and the retry still counts as new

Rules:

- **All events are stored**, noise included, with the filter verdict and `reason`
  (`signal:review`, `noise:+1`, `noise:bot`, …). `watcher refilter` re-evaluates stored
  events after filter changes without re-polling.
- **Baseline**: events that predate our watching an item are stored with
  `is_baseline = 1` and never make the item unread (`refilter` ignores them too). On an
  instance's first run (no cursor yet) that is every event of every item, so a fresh cache
  starts quiet. On later runs, an item seen for the first time (e.g. a new PR, or a new
  review request) only has its events older than the run's `since` marked as baseline; the
  newer ones count as usual. `baseline_at` records when the item was first seen.
- **Detection time**: `last_signal_at` is when *we detected* the latest signal (local
  clock), not the forge timestamp, so unread compares local time with local time and a
  late-arriving event with an old timestamp (e.g. an old commit pushed now) still counts.
- **Unread** ⇔ `last_signal_at > seen_at` (or `seen_at` null and any `last_signal_at`).
- **Own activity**: my own event newer than the latest new signal sets `seen_at`.
- **CI**: `ci_state` keeps the last *settled* result (`pending`, or no CI result at all as
  happens briefly right after a push, does not overwrite it); a
  first green result is not signal, a first red one or any later change is.
- **Conflicts**: an unknown mergeability (GitHub's `mergeable_state: "unknown"` while it
  recomputes) keeps the previous stored value, so a conflict is signalled only once.
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
- **Cursor advances whenever discovery succeeded**, so one failing item does not freeze
  it. Failed item fetches are recorded in the `retry` table and fetched again at the start
  of each following run (dedup keeps this harmless); a success removes the row, and after
  5 failed attempts the item is dropped from it (logged). The run is still reported as
  failed when items failed. Only a 404/410 on the item itself marks it gone; on a
  sub-request (timeline, PR, commits) it is an ordinary failure. CI is best-effort: a
  check-runs or status request the token cannot read (403/404, not a rate limit) counts
  as no CI data from that source, and with neither readable the CI state is unknown
  (the previous settled value is kept).
- Missing token in `.env` → instance disabled with a clear status message.
- HTTP: 30 s timeout; retry transient failures (5xx, network) up to 3 times with
  exponential backoff.
- **GitHub**: on a rate-limit response (403 with `X-RateLimit-Remaining: 0` or
  `Retry-After`, or 429), stop the instance cleanly without advancing the cursor and report
  the reset time. Search (30/min) is used three times per run. No ETag conditional requests:
  discovery only returns changed items, so a `304` would almost never happen.
- Other forges: at most 4 concurrent requests per instance, same backoff policy.

## 8. CLI

```
watcher poll [--instance ID] [--dry-run]   one-shot poll; --dry-run prints, writes nothing
watcher list [--all] [--muted]             unread items (usable before the web UI exists)
watcher seen URL... | --all               mark the given items seen, or all with --all
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
