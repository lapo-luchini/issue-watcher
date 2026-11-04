# Watcher — Plan 2b: Radicle adapter (record)

**Goal:** track Radicle issues and patches: on a public seed (`seed.radicle.garden`) for a listed set of repos the user sends patches to, and on the user's own `radicle-httpd` node for every repo it seeds.

**How this was done:** designed with the user (answers: both a seed with listed repos and the own node; `user` may be a list of DIDs, one per machine; incoming patches on repos the user maintains are important by default), then implemented directly test-first in one session while the user was away, as agreed. This file records the design decisions and the outcome instead of a step-by-step plan.

## Live API findings (seed.radicle.garden, radicle-httpd 0.28, API 6.2)

- Public, read-only JSON, no token. `GET /repos?show=all&page=N&perPage=M` (pages count from 0, no Link header), `GET /repos/:rid` (delegates, project name), `GET /repos/:rid/issues?status=open|closed|all`, `GET /repos/:rid/patches?status=open|draft|archived|merged|all`, `GET /repos/:rid/issues/:id`, `GET /repos/:rid/patches/:id` (404 when missing).
- Listings return whole objects: an issue's `discussion` (the first entry is its description), a patch's `revisions` (each with `discussions` and `reviews` with `verdict` accept/reject/null and `summary`), `merges` (author, commit, timestamp), `assignees` as `{id, alias}`, `labels`.
- No change history: state, labels and assignees are current values only. Timestamps are seconds, set by the author's clock (seen: comments dated 2018 on a 2026 issue).

## Design

- **Core:** `discover(since, known)` receives `KnownItem`s (ref + cached state). Snapshots may set `maintainedByMe`; PRs/patches with it are important by default (stored as `items.maintained_by_me`, added to existing caches).
- **Config:** type `radicle`; `user` a DID or a list (`users`); optional `repos` (rad:z… ids; absent = every repo the node seeds) and `web` (link base; default `https://app.radicle.xyz/nodes/<host>`).
- **Discovery:** per repo, list open issues and open + draft patches; keep items involving me (author, assignee, commenter, revision or review author), or all items on repos where I am a delegate; plus known items cached as open that are no longer listed as open. `since` is ignored. A configured repo missing on the node is an error.
- **Events:** comments (`c:<id>`), revisions as pushes (`rev:<id>`), reviews (`r:<id>`, approved / changes_requested / commented), merges (`m:<commit>`), closed/archived (`s:<state>`) and my assignment (`a:me`) timed by the latest activity. Roles: me (any of my DIDs), maintainer (delegate), contributor.
- **States:** issue open/closed (detail: reason); patch open, draft (open, detail "draft"), archived (closed, detail "archived"), merged.

## Outcome

Commits on branch `plan-2b-radicle`: known items carry their state; `maintainedByMe`; the adapter with config; docs. Tests: `test/radicle.test.ts` (13 tests) plus core tests. Live check against seed.radicle.garden: as a heartwood delegate, discovery returned its 300 open items and fetching them needed no extra request; as an outsider, nothing; a merged patch fetched by id reported its merger.

## Review and fixes

An independent review found, and these commits fix: known items still listed but no longer involving me (added by hand, unassigned) were never refreshed (now every item known as open is checked, free when listed); items first seen after the first run were filed as baseline by their author-set timestamps (snapshots now declare `timesUnreliable`, and such first sightings count as news); on an own node every repo cost an extra request per poll (the repo listing already carries delegates and names); a close after a reopen was never reported again (the state key counts activity); config mistakes that silently watch nothing are now errors.

## Known limitations

- Comments on an item that is already closed are not seen unless it is reopened (Radicle cannot say what changed, and re-fetching every closed item each poll would be costly).
- Closing, reopening and closing again with no activity in between is one state event; being unassigned and assigned again is not reported (no history to tell them apart).
- My own close, archive or self-assignment shows as unread: the API does not say who did it.
- A configured repo the node does not have fails discovery for the whole instance, with an error naming it (no cursor is involved, so nothing is lost once the config is fixed).
- Listings stop at 20 pages of 100 items per state, without a warning.
- A repo watched through two instances (seed and own node) appears twice: list on the seed only repos the own node does not seed.
- No CI state, no mentions (Radicle bodies have no @-mention convention the API exposes).
