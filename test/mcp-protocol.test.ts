// The JSON-RPC layer of the MCP server, over in-memory streams and a fake tool set.
import { expect, test } from "bun:test";
import { INVALID_PARAMS, RpcError, serve, ToolError, type ToolSet } from "../src/mcp/protocol.ts";

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
async function run(chunks: (string | Uint8Array)[]): Promise<any[]> {
  const out: string[] = [];
  await serve((async function* () { yield* chunks; })(), (l) => void out.push(l), tools, info);
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
