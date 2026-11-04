# Watcher — Plan 3: HTTP API, Vue UI, editing items.yaml

**Goal:** `watcher serve` starts a local web page: the table of tracked items (important first, most recent signal first) with unread markers, filters, the history of each item, starring, muting, notes, manual items and a "Poll now" button. Changes of intent are written to `data/items.yaml` and committed to git.

**How this is done:** implemented directly, test-first, during an agreed unattended session (the user approved the spec's UI and API sections earlier). This file is the task list and records the decisions taken; it is not a copy of the code.

**Architecture:** `src/core/intent.ts` gains comment-preserving edits of `items.yaml` (yaml Document API) and a git commit per change; `src/core/api.ts` gains every read and command the server needs, so the server never touches `Store` directly (a deferred plan-1 item); `src/server.ts` is a thin `Bun.serve` front end (JSON API + the SPA as an HTML import); `web/` holds the Vue 3 SPA with no build step (components are `.ts` modules with template strings, Vue's runtime-compiler browser build re-exported by `web/vue.ts`).

## Tasks

1. **Intent edits.** `editIntent(text, url, change)` returns the new YAML text: sets/clears `priority`, `muted`, `note`, keeps comments and order, never removes an entry (a URL alone still means "track this"); `addEntry(text, url, {manual, title})`. Matching uses canonical URLs, so an entry written as a browser URL is edited in place. `commitFile(repoDir, file, message)` runs `git commit` on that one file; failures (not a repo, no identity, nothing to commit) come back as a warning, the file stays written.
2. **API.** `ItemView` gains `id`-based lookup, separate `itemState`/`stateDetail`, labels, instance; `itemEvents(id, includeNoise)`; `instanceStatus()` (last run, last success, error per instance); `setIntent(id or url, change)` and `addItem(url, title)` (validate URL, recognize forge URLs as tracked items, others as manual), both write + commit; `markSeen` by id.
3. **Poll lock with pid.** The lock holder records `pid@host`; a lock whose process is gone (same host, `kill(pid, 0)` fails) is taken over at once instead of after 30 minutes. Needed now that a long-running server polls next to cron.
4. **HTTP server.** Routes from the spec (section 6). Binds `127.0.0.1` unless `WATCHER_HOST` is set. Mutating requests must be JSON (`Content-Type: application/json`) and, when the browser sends an `Origin`, come from the page's own origin: blocks cross-site requests (CSRF) and DNS-rebinding tricks against the local server. `POST /api/poll` starts a poll in the background and answers 202, or 409 while one runs (also when cron's poll holds the lock). `items.yaml` is re-read on every request, so hand edits and `git pull`s are picked up; the config is read at start.
5. **Web UI.** `web/index.html`, `web/main.ts`, `web/vue.ts`, `web/api.ts`, `web/components/*.ts`, `web/style.css`: top bar (unread only, important only, show muted, forge filter, add item, Poll now with per-instance status), table (unread dot, star toggle, forge + repo, title link that marks seen, state with CI, latest signal, relative time), expandable row with the signal history and a "show filtered" toggle (noise greyed with its reason), row menu (mute, note, copy URL), "mark all seen". Light/dark via `prefers-color-scheme`.
6. **CLI `serve`, README.** `watcher serve [--port N] [--host H]`; README section on the web UI and on exposing it (reverse proxy with authentication only).

## Decisions taken without the user (to confirm)

- Adding a URL that a configured instance recognizes creates a normal (tracked) `items.yaml` entry, fetched on the next poll; any other URL becomes a manual item.
- Commit messages: `watcher: mark <repo>#<n> important|normal`, `watcher: mute|unmute …`, `watcher: note on …`, `watcher: add …`; a short label is derived from the URL.
- Removing a note or resetting priority to the default removes the key from `items.yaml`; the entry itself stays, even with only its URL left (an item added by URL may not have been fetched yet).

## Outcome

(filled in at the end)
