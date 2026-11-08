# watcher

Tracks the PRs, issues and bugs you are involved in across forges, and shows only meaningful
activity: reviews, maintainer comments, state changes, CI results. It ignores "+1"s, emoji, bots
and "any update?" pings. Design: `docs/superpowers/specs/2026-11-04-pr-watcher-design.md`.

## Setup

Requires [Bun](https://bun.sh) ≥ 1.4 (Linux or FreeBSD).

```sh
bun install
cp data/config.example.yaml data/config.yaml   # set your logins; commit it on the config branch (below)
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
  are only seen if it is reopened. Its times come from authors' clocks, and changes can reach
  the node days late: a time that cannot be right (before the previous poll, which did not see
  the change yet, or in the future) is shown as an approximation, "≈ 2 h ago", with the
  author's time on hover.

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
and committed to git, one commit per change, with the repository's git identity, on the
`config` branch (see below). If the commit fails, the change is still saved and the page says why.

The server has no authentication: it listens on 127.0.0.1 only, and refuses requests that do
not come from its own page. To reach it from elsewhere, put it behind a reverse proxy that
authenticates, and tell the server the public name the proxy forwards
(`WATCHER_ALLOWED_HOSTS=watcher.example.org`, comma-separated); never expose it directly.
Requests naming any other host are refused, whatever address the server listens on, so a
hostile web page cannot reach it through a DNS name of its own.

The proxy must pass the public name on in the `Host` header: changes from the page are refused
unless it matches the host in the browser's `Origin`. With nginx (TLS and basic auth set up as
usual):

```nginx
location / {
    proxy_pass http://127.0.0.1:8411;
    proxy_set_header Host $host;                  # the public name (standard port 443)
    # proxy_set_header Host $host:$server_port;   # on a non-standard port, e.g. 8443
}
```

Use `$host`, not `$http_host`: over HTTP/2 browsers send no `Host` header, so `$http_host` can be
empty, and a request without `Host` is refused with 400. Without the line, nginx sends
`Host: 127.0.0.1:8411`: the page loads, but every change fails with 403 "cross-origin request".

`WATCHER_DEV=1` turns on Bun's development mode (live reload of the page) for working on the UI.

## Polling periodically

The poll is a one-shot command, so run it from cron or a systemd timer, e.g. every 20 minutes:

```cron
*/20 * * * * cd /path/to/watcher && /usr/local/bin/bun src/cli.ts poll >/dev/null
```

## Your data and the `config` branch

The code can be published; your configuration and intent should not be. So the watcher
commits changes to `data/items.yaml` to a local branch, `config` (`commit_branch:` in
`config.yaml` to name it otherwise), whatever is checked out:

- with `config` checked out, they are ordinary commits;
- with another branch checked out (say `trunk`), the file is updated in the working copy and
  the commit goes to `config` without touching your branch, index or other files; a missing
  `config` branch is created from the current commit.

On published branches `data/config.yaml` and `data/items.yaml` are git-ignored. The simplest
setup is to run the watcher from a `config` checkout and keep the code current by merging:

```sh
git switch -c config                 # once; later: git switch config
git add -f data/config.yaml && git commit -m "My watcher config"
git merge trunk                      # whenever trunk has new code
git push origin trunk                # publish trunk only; config stays local
```

## Files

| Path               | In git                  | Content                                              |
|--------------------|-------------------------|------------------------------------------------------|
| `data/config.yaml` | on the `config` branch  | instances and filter tuning                          |
| `data/items.yaml`  | on the `config` branch  | your intent: priority, mute, notes, manual items     |
| `.env`             | no                      | tokens                                               |
| `var/cache.sqlite` | no                      | cache; delete it to start over from a quiet baseline |

## License

ISC, see [LICENSE](LICENSE).
