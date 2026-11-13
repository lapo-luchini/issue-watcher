// The Model Context Protocol over stdio, tools only: newline-delimited JSON-RPC 2.0. Written here
// rather than taken from the SDK (see docs/superpowers/specs/2026-11-10-mcp-server-design.md).
// Knows nothing about the watcher: the tools come from a `ToolSet`.

/** The protocol versions we speak, newest first. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/** Answered to the client as a JSON-RPC error. */
export class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

/** A tool that failed in a way the assistant should see (bad argument, unknown item…): `isError`, not a JSON-RPC error. */
export class ToolError extends Error {}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

export interface ToolSet {
  list(): ToolDef[];
  /** Returns the text for the assistant; throws ToolError for a failure it should see, RpcError(INVALID_PARAMS) for an unknown tool. */
  call(name: string, args: Record<string, unknown>): Promise<string>;
}

export interface ServerInfo {
  name: string;
  version: string;
}

type Id = string | number;
type Reply = { jsonrpc: "2.0"; id: Id | null } & ({ result: unknown } | { error: { code: number; message: string } });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Handles one message (one line, already read); returns the reply, or null when none is due. */
export async function handleMessage(line: string, tools: ToolSet, info: ServerInfo): Promise<Reply | null> {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null, PARSE_ERROR, "parse error");
  }
  if (!isObject(msg) || msg.jsonrpc !== "2.0") return fail(null, INVALID_REQUEST, "not a JSON-RPC 2.0 request object");
  if (typeof msg.method !== "string") {
    // A response to a request of ours (we send none) is ignored; anything else is not a request.
    return "result" in msg || "error" in msg ? null : fail(null, INVALID_REQUEST, "missing method");
  }
  const notification = !("id" in msg);
  if (!notification && typeof msg.id !== "string" && typeof msg.id !== "number") return fail(null, INVALID_REQUEST, "id must be a string or a number");
  const id = notification ? null : (msg.id as Id);
  try {
    const result = await dispatch(msg.method, msg.params, tools, info);
    return notification ? null : { jsonrpc: "2.0", id: id!, result };
  } catch (err) {
    if (notification) return null; // notifications get no reply, not even an error
    if (err instanceof RpcError) return fail(id, err.code, err.message);
    return fail(id, INTERNAL_ERROR, `internal error: ${(err as Error).message}`);
  }
}

function fail(id: Id | null, code: number, message: string): Reply {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function dispatch(method: string, params: unknown, tools: ToolSet, info: ServerInfo): Promise<unknown> {
  switch (method) {
    case "initialize": {
      const asked = isObject(params) ? params.protocolVersion : undefined;
      const version = PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0];
      return { protocolVersion: version, capabilities: { tools: {} }, serverInfo: info };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: tools.list() };
    case "tools/call": {
      if (!isObject(params)) throw new RpcError(INVALID_PARAMS, "params must be an object");
      if (typeof params.name !== "string") throw new RpcError(INVALID_PARAMS, "params.name must be the tool's name");
      if (params.arguments !== undefined && !isObject(params.arguments)) throw new RpcError(INVALID_PARAMS, "params.arguments must be an object");
      try {
        return { content: [{ type: "text", text: await tools.call(params.name, params.arguments ?? {}) }] };
      } catch (err) {
        if (err instanceof ToolError) return { content: [{ type: "text", text: err.message }], isError: true };
        throw err;
      }
    }
    default:
      throw new RpcError(METHOD_NOT_FOUND, `unknown method: ${method}`);
  }
}

/**
 * Serves until `input` ends: one request at a time, in order, one JSON object per line each way.
 * `write` gets complete lines (with the newline); stdout must carry nothing else.
 */
export async function serve(
  input: AsyncIterable<Uint8Array | string>, write: (line: string) => void, tools: ToolSet, info: ServerInfo,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = async (line: string) => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (text.trim() === "") return;
    const reply = await handleMessage(text, tools, info);
    if (reply) write(JSON.stringify(reply) + "\n");
  };
  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      await handle(line);
    }
  }
  buffer += decoder.decode();
  await handle(buffer); // a last line without its newline
}
