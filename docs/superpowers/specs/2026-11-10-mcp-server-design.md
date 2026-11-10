# MCP server: design

Status: draft, not yet approved. Follows §10 of `2026-11-04-pr-watcher-design.md` ("another thin
front end over `api.ts`").

## Goal

Let an AI assistant (Claude Code, Claude Desktop, any MCP client) answer "what happened on my PRs
this week?", show an item's history and, when allowed, act on items as the web page does.

## Decisions

- **Transport: stdio, same machine.** The client starts `bun run watcher mcp` (or
  `bun /path/to/watcher/src/cli.ts mcp`) and talks to it over stdin/stdout. No network port, no
  authentication to design. HTTP (through the nginx proxy, OAuth for claude.ai) is out of scope;
  the tools below would carry over unchanged.
- **Protocol written in-house, no SDK.** Over stdio, MCP is newline-delimited JSON-RPC 2.0, and a
  tools-only server needs five messages. The official SDK would bring about 17 dependencies
  (express, hono, jose, ajv, zod, …), mostly for HTTP and OAuth, to a project that has two.
  Revisit if HTTP transport is ever added.
- **Read-only unless configured otherwise.** Tool results contain text written by strangers
  (comment excerpts, titles), which the assistant reads: a prompt injected there must not be able
  to mute, annotate or add items unless the user chose to allow writes.

## Configuration

`data/config.yaml` gains an optional section:

```yaml
mcp:
  read_only: false   # default: true
```

`read_only` must be a boolean; anything else is a config error. With `read_only: true` (or no `mcp:`
section) the write tools are **not listed** by `tools/list`, and calling one is answered as an
unknown tool.

## Architecture

| File                   | Responsibility                                                                 |
|------------------------|--------------------------------------------------------------------------------|
| `src/mcp/protocol.ts`  | Generic JSON-RPC over line-delimited streams: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`; error codes. Knows nothing about the watcher. |
| `src/mcp/tools.ts`     | Tool definitions (name, description, JSON Schema for input), argument checks, calls into `api.ts`. |
| `src/core/context.ts`  | Shared setup now inside `startServer`: load config, URL recognizer, open the store, read `items.yaml` canonicalized, the `IntentRepo` for commits. Used by the server and by `mcp`. |
| `src/cli.ts`           | New `mcp` command.                                                             |
| `src/core/store.ts`    | One new query for `updates` (below).                                           |

### Protocol

- One JSON object per line on stdin; one per line on stdout. stdout carries protocol only; any
  logging goes to stderr.
- `initialize`: answer with the client's `protocolVersion` if supported (`2025-11-25`,
  `2025-06-18`, `2025-03-26`, `2024-11-05`), else the newest supported; capabilities
  `{ tools: {} }`; `serverInfo` `{ name: "watcher", version }` from `package.json`.
- `notifications/initialized` and other notifications: no reply.
- `ping`: empty result.
- `tools/list`: every available tool, no pagination.
- `tools/call`: runs the tool; its result is `{ content: [{ type: "text", text: <JSON> }] }`.
  A failing tool (bad argument, unknown item, commit refused) returns `isError: true` with the
  message as text, so the assistant sees it; it is not a JSON-RPC error.
- JSON-RPC errors: unparseable line -32700, not a request object -32600, unknown method -32601,
  unknown tool or params not an object -32602, unexpected exception -32603.
- Requests are handled one at a time, in order. EOF on stdin ends the process (closing the store).

## Tools

Where a tool takes `item`, it accepts an item URL (also one copied from the browser: canonicalized
as the CLI's `seen` does) or the item's id from a previous result.

### Read (always available)

- `list_items({ unread?, important?, include_muted?, instance? })`: as the page's list
  (`listItems`), same order. Each item: url, id, title, instance, repo, kind, state, ci, conflicts,
  priority, muted, note, unread, latest news (time and summary), updated and created dates.
- `get_item({ item, include_filtered? })`: the item as above plus its history (`itemEvents`);
  with `include_filtered`, also the events the filter dropped, each with its reason.
- `updates({ since })`: the news (signal events) the watcher **detected** after `since` (ISO 8601
  time), grouped by item, newest first; muted items left out. Detection time, not the event's own
  time, so changes that reach the watcher late (Radicle) are not missed. Needs a store query on
  `events.detected_at`.
- `status()`: per instance the last run, last success and error (`instanceStatus`), and whether
  a poll is running (the poll lock).

### Write (only with `read_only: false`)

- `mark_seen({ items } | { all: true })`: `markSeen`; returns how many were marked.
- `update_item({ item, priority?, muted?, note? })`: same validation as the page's PATCH
  (`priority`: `important`, `normal` or `null` for the default; `note`: text or `null`), same commit
  to the `config` branch via `changeIntent`. A commit warning is returned with the updated item.
- `add_item({ url, title? })`: `addItem`; returns the canonical URL, whether it is manual, and any
  commit warning.
- `poll()`: starts a poll in the background and returns at once; `status()` follows it. Refused
  while another poll (cron's, the web page's) holds the lock. Background because a poll can take
  minutes (slow forges, retries), longer than clients wait for a tool call. The process stays alive
  until the poll ends even if stdin closes.

## Error handling

- Config or store errors at startup: message on stderr, exit code 1 (the client shows the server
  as failed).
- `items.yaml` is re-read on each call, as the server does, so hand edits and `git pull`s apply
  at once.
- Concurrent writers (cron poll, web server) are already handled by SQLite WAL, `busy_timeout`,
  the poll lock and the serialized `items.yaml` commits.

## Testing

- `protocol.ts`: in-memory streams; initialize and version negotiation, ping, notifications get no
  reply, each JSON-RPC error code, tool errors as `isError`.
- `tools.ts`: in-memory store and intent; each tool's output; read-only hides and refuses write
  tools; item by URL and by id; `updates` uses detection time and skips muted items.
- End to end: spawn `bun src/cli.ts mcp` with a temporary home; `initialize`, `tools/list`,
  `tools/call list_items`.

## Documentation

README section "AI assistants (MCP)": what it offers, the `read_only` switch and why it defaults
to true, and how to register it, e.g.

```sh
claude mcp add watcher -- bun /path/to/watcher/src/cli.ts mcp
```

and the equivalent `mcpServers` entry for Claude Desktop's JSON configuration.

## Out of scope

HTTP transport, resources and prompts (tools only), notifications to the client when a poll finds
news.
