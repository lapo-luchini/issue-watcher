# watcher

Tracks the PRs, issues and bugs you are involved in across forges, and shows only meaningful
activity: reviews, maintainer comments, state changes, CI results. It ignores "+1"s, emoji, bots
and "any update?" pings. Design: `docs/superpowers/specs/2026-11-04-pr-watcher-design.md`.

## Setup

Requires [Bun](https://bun.sh) ≥ 1.4 (Linux or FreeBSD).

```sh
bun install
cp data/config.example.yaml data/config.yaml   # set your logins, then commit it (no secrets inside)
cp .env.example .env                           # put your tokens here (git-ignored)
bun run watcher poll --dry-run                 # check instances and tokens; saves nothing
bun run watcher poll                           # first real run: records history as baseline
```

### Tokens

The watcher only reads, so give every token read-only access.

- **GitHub**: a **classic** personal access token with just the `notifications` scope:
  public repositories, search and CI status need no scope at all. (Don't pick `public_repo`
  or `repo`: those grant write access. `repo` is only needed to watch private repositories.)
  Fine-grained tokens with "Public repositories (read-only)" access work too, but they cannot
  read notifications, so issues you only *subscribed to* are not discovered.
- **GitLab** (gitlab.com, invent.kde.org, …): a personal access token with the `read_api`
  scope (User settings → Access tokens). Required: GitLab's searches, to-dos and comments are
  not readable anonymously.
- **Forgejo** (codeberg.org, …): an access token (Settings → Applications) with read access
  to *issue*, *notification* and *repository*. Required: without a token, searches return
  everyone's items. Without the notification permission, items you only commented on are not
  discovered; without the repository permission, maintainers are not recognized.
- **Bugzilla** (bugs.freebsd.org, bugs.kde.org, bugzilla.mozilla.org): an API key
  (Preferences → API Keys). Optional: public bugs and searches work anonymously; a key is
  needed for bugs only logged-in users can see. `user` is your login email; list your other
  addresses in `emails` so your comments under them are recognized as yours.
- **Radicle**: no token. Point an instance at a `radicle-httpd` API (`…/api/v1`): a public
  seed with a `repos:` list for repositories you contribute to, and/or your own node, which
  watches every repository it seeds. `user` is your Radicle ID (`did:key:z6Mk…`), or a list if
  you have one per machine. Radicle has no change history: closing an issue shows up as a
  state change timed by the item's latest activity, and comments on an already closed item
  are only seen if it is reopened.

## Commands

```
bun run watcher poll [--instance ID] [--dry-run]
bun run watcher list [--all] [--muted]
bun run watcher seen URL... | --all
bun run watcher refilter
bun run watcher serve [--port N] [--host H]
```

`seen` takes item URLs as `list` shows them (a URL copied from the browser, e.g. with
`/files` or a `#fragment`, works too); marking everything seen needs `seen --all`.

## Web UI

```sh
bun run watcher serve            # http://127.0.0.1:8411/  (--port N, --host H; or WATCHER_PORT, WATCHER_HOST)
```

The page lists every tracked item, important ones first, then by latest activity; unread items
have a blue bar on the left. Click a row for its history (tick "Show filtered" to also see what
the noise filter dropped, and why), to mute it, or to add a note; the star toggles importance.
"Add item" takes any URL: forge items are fetched on the next poll, other pages (a
mailing-list post, say) are listed as manual items. "Poll now" polls in the background.

Stars, mutes, notes and added items are written to `data/items.yaml` (comments and order kept)
and committed to git, one commit per change, with the repository's git identity. If the commit
fails, the change is still saved and the page says why.

The server has no authentication: it listens on 127.0.0.1 only, and refuses requests that do
not come from its own page. To reach it from elsewhere, put it behind a reverse proxy that
authenticates, and tell the server the public name the proxy forwards
(`WATCHER_ALLOWED_HOSTS=watcher.example.org`, comma-separated); never expose it directly.

## Polling periodically

The poll is a one-shot command, so run it from cron or a systemd timer, e.g. every 20 minutes:

```cron
*/20 * * * * cd /path/to/watcher && /usr/local/bin/bun src/cli.ts poll >/dev/null
```

## Files

| Path               | In git | Content                                              |
|--------------------|--------|------------------------------------------------------|
| `data/config.yaml` | yes    | instances and filter tuning                          |
| `data/items.yaml`  | yes    | your intent: priority, mute, notes, manual items     |
| `.env`             | no     | tokens                                               |
| `var/cache.sqlite` | no     | cache; delete it to start over from a quiet baseline |
