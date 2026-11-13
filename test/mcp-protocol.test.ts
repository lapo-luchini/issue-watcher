// The JSON-RPC layer of the MCP server, over in-memory streams and a fake tool set.
import { expect, test } from "bun:test";
import { INVALID_PARAMS, MAX_LINE, RpcError, serve, ToolError, type ToolSet } from "../src/mcp/protocol.ts";

const info = { name: "watcher", version: "9.9.9" };

const tools: ToolSet = {
  list: () => [{ name: "echo", description: "Echoes.", inputSchema: { type: "object", properties: {} } }],
  call: async (name, args) => {
    if (name === "echo") return JSON.stringify(args);
    if (name === "refuse") throw new ToolError("no such item");
    if (name === "crash") throw new Error("boom");
    throw new RpcError(INVALID_PARAMS, `unknown tool: ${name}`);
  },
};

/** Feeds `chunks` to a server and returns the parsed lines it wrote. */
async function run(chunks: (string | Uint8Array)[], maxLine?: number): Promise<any[]> {
  const out: string[] = [];
  await serve((async function* () { yield* chunks; })(), (l) => void out.push(l), tools, info, maxLine);
  for (const l of out) expect(l.endsWith("\n") && !l.slice(0, -1).includes("\n")).toBe(true); // one object per line
  return out.map((l) => JSON.parse(l));
}

const req = (id: unknown, method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

test("initialize: the client's version when supported, else the newest; tools capability; server info", async () => {
  const r = await run([req(1, "initialize", { protocolVersion: "2025-03-26" }), req(2, "initialize", { protocolVersion: "1999-01-01" }), req(3, "initialize")]);
  expect(r[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: info } });
  expect(r[1].result.protocolVersion).toBe("2025-11-25");
  expect(r[2].result.protocolVersion).toBe("2025-11-25");
});

test("notifications get no reply, known or not, even when they would fail; ping answers empty", async () => {
  const note = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
  const r = await run([note("notifications/initialized"), note("notifications/whatever", [1]), note("tools/call", 3), req("p", "ping")]);
  expect(r).toEqual([{ jsonrpc: "2.0", id: "p", result: {} }]);
});

test("tools/list and tools/call: the result is one text content; a ToolError is isError, not a JSON-RPC error", async () => {
  const r = await run([
    req(1, "tools/list"), req(2, "tools/call", { name: "echo", arguments: { a: 1 } }), req(3, "tools/call", { name: "echo" }),
    req(4, "tools/call", { name: "refuse" }),
  ]);
  expect(r[0].result.tools.map((t: any) => t.name)).toEqual(["echo"]);
  expect(r[1].result).toEqual({ content: [{ type: "text", text: '{"a":1}' }] });
  expect(r[2].result.content[0].text).toBe("{}"); // no arguments: an empty object
  expect(r[3]).toEqual({ jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "no such item" }], isError: true } });
});

test("JSON-RPC errors: -32700 unparseable, -32600 not a request, -32601 unknown method, -32602 bad params or tool, -32603 exception", async () => {
  const r = await run([
    "{nope\n", "[1,2]\n", "7\n", '{"jsonrpc":"2.0","id":1}\n', '{"jsonrpc":"2.0","id":{},"method":"ping"}\n', '{"id":1,"method":"ping"}\n',
    req(2, "bogus"), req(3, "tools/call", "x"), req(4, "tools/call", {}), req(5, "tools/call", { name: "echo", arguments: [1] }),
    req(6, "tools/call", { name: "nope" }), req(7, "tools/call", { name: "crash" }),
    '{"jsonrpc":"2.0","id":9,"result":{}}\n', // a response from the client: ignored
  ]);
  expect(r.map((x) => [x.id, x.error?.code])).toEqual([
    [null, -32700], [null, -32600], [null, -32600], [null, -32600], [null, -32600], [null, -32600],
    [2, -32601], [3, -32602], [4, -32602], [5, -32602], [6, -32602], [7, -32603],
  ]);
  expect(r[10].error.message).toBe("unknown tool: nope");
  expect(r[11].error.message).toContain("boom");
});

test("lines split across chunks, with CRLF, blank lines and a last line without newline; bytes too", async () => {
  const bytes = new TextEncoder().encode(req(2, "ping") + req(3, "tools/call", { name: "echo", arguments: { s: "héllo" } }));
  const r = await run(["\r\n\n", req(1, "pi").slice(0, 10), req(1, "ping").slice(10).replace("\n", "\r\n"), bytes.slice(0, 40), bytes.slice(40), req(4, "ping").trimEnd()]);
  expect(r.map((x) => x.id)).toEqual([1, 2, 3, 4]);
  expect(JSON.parse(r[2].result.content[0].text)).toEqual({ s: "héllo" });
});

test("requests are handled one at a time, in order", async () => {
  const order: string[] = [];
  const slow: ToolSet = {
    list: () => [],
    call: async (name) => {
      order.push(`start ${name}`);
      await Bun.sleep(name === "a" ? 30 : 0);
      order.push(`end ${name}`);
      return name;
    },
  };
  const out: string[] = [];
  await serve((async function* () { yield req(1, "tools/call", { name: "a" }) + req(2, "tools/call", { name: "b" }); })(), (l) => void out.push(l), slow, info);
  expect(order).toEqual(["start a", "end a", "start b", "end b"]);
  expect(out.map((l) => JSON.parse(l).id)).toEqual([1, 2]);
});

test("an id that cannot be written back (1e400 reads as Infinity) is an invalid request, not a reply with a null id", async () => {
  const r = await run(['{"jsonrpc":"2.0","id":1e400,"method":"ping"}\n']);
  expect(r).toEqual([{ jsonrpc: "2.0", id: null, error: { code: -32600, message: "id must be a string or a number" } }]);
});

test("tools/call with params that are not an object, or without a text name: invalid params, each saying which", async () => {
  const r = await run([req(1, "tools/call", null), req(2, "tools/call", [1]), req(3, "tools/call", "echo"), req(4, "tools/call", {}), req(5, "tools/call", { name: 5 })]);
  expect(r.map((x) => x.error.code)).toEqual([-32602, -32602, -32602, -32602, -32602]);
  expect(r.slice(0, 3).map((x) => x.error.message)).toEqual(Array(3).fill("params must be an object"));
  expect(r.slice(3).map((x) => x.error.message)).toEqual(Array(2).fill("params.name must be the tool's name"));
});

test("a character split between two chunks arrives whole", async () => {
  const bytes = new TextEncoder().encode(req("€", "ping"));
  const cut = bytes.indexOf(0xe2) + 1; // inside the euro sign's three bytes
  const r = await run([bytes.slice(0, cut), bytes.slice(cut)]);
  expect(r).toEqual([{ jsonrpc: "2.0", id: "€", result: {} }]);
});

const ping = (id: number) => req(id, "ping");
const TOO_LONG = { jsonrpc: "2.0", id: null, error: { code: -32700, message: expect.stringContaining("line longer than") } };

test("a line over the limit is refused with one parse error and skipped to its newline, wherever the limit is crossed", async () => {
  const long = "x".repeat(100);
  const ok = { jsonrpc: "2.0", id: 2, result: {} };
  // The line arrives in pieces and ends in a later chunk; the limit is crossed in the first.
  expect(await run([long.slice(0, 60), long.slice(60, 80), long.slice(80) + "\n" + ping(2)], 50)).toEqual([TOO_LONG, ok]);
  // The limit is crossed by the piece that holds the newline.
  expect(await run([long + "\n" + ping(2)], 50)).toEqual([TOO_LONG, ok]);
  // Not ended at all.
  expect(await run([long.slice(0, 60), long.slice(60)], 50)).toEqual([TOO_LONG]);
  // Several chunks later still skipped, then normal again (and a skipped line's tail is no message).
  expect(await run([long, long, long + "\n" + ping(2) + long + "\n" + ping(3)], 50)).toEqual([TOO_LONG, ok, TOO_LONG, { ...ok, id: 3 }]);
});

test("a line of exactly the limit is handled", async () => {
  const line = ping(1).trimEnd();
  expect(await run([line.slice(0, 10), line.slice(10) + "\n"], line.length)).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  expect(await run([line + "\n"], line.length - 1)).toEqual([TOO_LONG]);
});

test("20 MiB without a newline, in 64 KiB chunks: refused at the 16 MiB limit, the next request still answered", async () => {
  const chunk = "y".repeat(64 * 1024);
  const chunks = Array.from({ length: 320 }, () => chunk);
  chunks.push("\n" + ping(7));
  expect(await run(chunks)).toEqual([TOO_LONG, { jsonrpc: "2.0", id: 7, result: {} }]);
});

const PONG = (id: number) => ({ jsonrpc: "2.0", id, result: {} });
/** A valid ping request of exactly `n` characters (padded in a params field). */
const pingOf = (id: number, n: number) => {
  const head = `{"jsonrpc":"2.0","id":${id},"method":"ping","params":{"p":"`;
  const tail = '"}}';
  return head + "a".repeat(n - head.length - tail.length) + tail;
};

test("the limit is per line: many valid lines whose total passes it are all answered, and one of exactly the limit follows", async () => {
  const limit = 80;
  // Five lines of 70 characters: together far over the limit, each under it.
  const lines = [1, 2, 3, 4, 5].map((i) => pingOf(i, 70) + "\n");
  expect(await run(lines, limit)).toEqual([1, 2, 3, 4, 5].map(PONG));
  // After a short line, a line of exactly the limit is handled (the count restarts at 0, not at 1).
  expect(await run([pingOf(1, 70) + "\n", pingOf(2, limit) + "\n"], limit)).toEqual([PONG(1), PONG(2)]);
});

test("after a refused line whose newline comes in a later chunk, the next line of exactly the limit is handled", async () => {
  const limit = 80;
  expect(await run(["x".repeat(limit + 20), "\n" + pingOf(4, limit) + "\n"], limit)).toEqual([TOO_LONG, PONG(4)]);
});

test("a line that starts with a carriage return is read whole (only a trailing one is dropped)", async () => {
  expect(await run(["\r" + pingOf(5, 70) + "\n"])).toEqual([PONG(5)]);
  expect(await run([pingOf(6, 70) + "\r\n"])).toEqual([PONG(6)]);
});

test("the default limit is 16 MiB: a line of exactly that many characters is handled, one more is refused", async () => {
  expect(MAX_LINE).toBe(16 * 1024 * 1024);
  const chunks = (line: string) => {
    const out: string[] = [];
    for (let i = 0; i < line.length; i += 1 << 20) out.push(line.slice(i, i + (1 << 20)));
    out.push("\n");
    return out;
  };
  expect(await run(chunks(pingOf(8, MAX_LINE)))).toEqual([PONG(8)]);
  expect(await run(chunks(pingOf(8, MAX_LINE + 1)))).toEqual([TOO_LONG]);
});
