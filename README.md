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
  Codeberg's search often takes 10 s or more, and over 30 s when the site is busy, failing the
  poll with "The operation timed out": give the instance a longer `timeout:` (seconds, e.g. 90).
  A failed poll loses nothing: the next one searches again from where the last good one ended.
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
bun run watcher mcp
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

## AI assistants (MCP)

`watcher mcp` is an [MCP](https://modelcontextprotocol.io/) server over stdio, so that an AI
assistant (Claude Code, Claude Desktop, any MCP client) can answer "what happened on my PRs this
week?", show an item's history and, if you allow it, act on items as the web page does. The client
starts it as a child process on the same machine: there is no port to open and nothing to
authenticate. Register it with the path to your checkout, e.g.:

```sh
claude mcp add watcher -- bun /path/to/watcher/src/cli.ts mcp
```

or, in Claude Desktop's JSON configuration:

```json
{ "mcpServers": { "watcher": { "command": "bun", "args": ["/path/to/watcher/src/cli.ts", "mcp"] } } }
```

It reads the same `data/` and `var/` as the other commands (`WATCHER_HOME` as well), so poll
periodically as usual; new data and hand edits to `items.yaml` are seen at once, but a change to
`config.yaml` (also `mcp.read_only`) needs the assistant to restart the server.

| Tool          | What it does                                                                      |
|---------------|-----------------------------------------------------------------------------------|
| `list_items`  | the page's list: `unread`, `important`, `include_muted`, `instance` filter it      |
| `get_item`    | one item (by URL or id) and its history; `include_filtered` adds the noise events  |
| `list_registers` | the registers, and the one used when a call names none                          |
| `updates`     | news detected after a time (`since`), by item                                      |
| `status`      | the last poll per instance, and whether a poll is running                          |
| `mark_seen`   | mark given items, or `all`, seen                                                   |
| `update_item` | priority, mute and note, committed to the `config` branch as the web page does     |
| `add_item`    | track an item by URL                                                               |
| `poll`        | start a poll in the background (`status` follows it)                               |

`list_items`, `get_item`, `update_item` and `add_item` take a `register` (see "Registers"); the
others look at the cache as a whole. The last four change things and are **off by default**: with `mcp.read_only` unset or `true` in
`data/config.yaml` they are not listed, and calling one is answered as an unknown tool. What the
assistant reads includes text written by strangers (titles, comment excerpts), and a prompt
injected there must not be able to mute, annotate or add items. Allow writes only if you accept
that:

```yaml
mcp:
  read_only: false
```

## Registers

A register is a named list of entries (priority, mute, note, manual items), a file of the
format of `data/items.yaml`: that file is the register `default`, and `data/registers/<name>.yaml`
(a lowercase name of letters, digits, `-` and `_`) is the register `<name>`. An install with only
`items.yaml` works as before. There is one cache and one poll: it fetches the entries of every
register (an item in two registers is fetched once) and, as before, what discovery finds for
you. A register's stars, mutes and notes are its own: they show only where the item is an entry.

- `default` lists everything the cache has; any other register lists its own entries.
- `watcher list --register NAME` (or `WATCHER_REGISTER=NAME`) shows one; `watcher registers`
  lists them. The web API takes `?register=NAME` on the item routes, and `GET /api/registers`.
- The MCP server uses `WATCHER_REGISTER` (default `default`) for calls that name no register.
- `add_item` (and `POST /api/items`) to a register without a file creates it.
- The priority an item is judged by when polled is `important` if any register says so.

Every register file is changed under the one lock `var/items.lock`, and each change is its own
commit to the `config` branch (the message ends `(register NAME)` for a register other than
`default`).

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

On published branches `data/config.yaml`, `data/items.yaml` and `data/registers/` are git-ignored. The simplest
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
| `data/registers/`  | on the `config` branch  | more registers, same format (see "Registers")        |
| `.env`             | no                      | tokens                                               |
| `var/cache.sqlite` | no                      | cache; delete it to start over from a quiet baseline |

## License

ISC, see [LICENSE](LICENSE).
