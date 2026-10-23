// Minimal LSP client for lazyverilog-lsp (UTF-8 position encoding).

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Wait this long for the server to publish diagnostics (= parse done) after open/change.
const PARSE_TIMEOUT_MS = 15_000;
// Wait this long for the first project index publish after startup.
const INDEX_TIMEOUT_MS = Number(process.env.LAZYVERILOG_INDEX_TIMEOUT ?? "30") * 1000;

export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}
export interface TextEdit {
  range: Range;
  newText: string;
}
export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: Array<{ textDocument?: { uri: string }; edits?: TextEdit[] }>;
}
export interface Diagnostic {
  range: Range;
  message: string;
  severity?: number;
}

export class LspError extends Error {}

export const pathToUri = (p: string): string => pathToFileURL(path.resolve(p)).href;
export const uriToPath = (uri: string): string => path.normalize(fileURLToPath(uri));
export const pathKey = (p: string): string => {
  const abs = path.resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
};

function lineStarts(data: Buffer): number[] {
  const starts = [0];
  for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, i + 1)) starts.push(i + 1);
  return starts;
}

/** LSP position (UTF-8 columns) -> byte offset, clamped to the line. */
function offset(data: Buffer, starts: number[], pos: Position): number {
  if (pos.line >= starts.length) return data.length;
  const end = pos.line + 1 < starts.length ? starts[pos.line + 1] - 1 : data.length;
  return Math.min(starts[pos.line] + pos.character, end);
}

export function applyTextEdits(data: Buffer, edits: TextEdit[]): Buffer {
  const starts = lineStarts(data);
  const spans = edits
    .map((e) => ({ start: offset(data, starts, e.range.start), end: offset(data, starts, e.range.end), text: e.newText }))
    .sort((a, b) => b.start - a.start || b.end - a.end);
  for (const s of spans) data = Buffer.concat([data.subarray(0, s.start), Buffer.from(s.text), data.subarray(s.end)]);
  return data;
}

export function workspaceEditByPath(edit: WorkspaceEdit | null | undefined): Map<string, TextEdit[]> {
  const out = new Map<string, TextEdit[]>();
  const add = (uri: string, edits: TextEdit[]) => {
    const p = uriToPath(uri);
    out.set(p, [...(out.get(p) ?? []), ...edits]);
  };
  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) add(uri, edits);
  // Skip create/rename/delete file operations.
  for (const change of edit?.documentChanges ?? []) if (change.textDocument) add(change.textDocument.uri, change.edits ?? []);
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface Doc {
  uri: string;
  version: number;
  data: Buffer;
}

export class LspClient {
  readonly root: string;
  readonly diagnostics = new Map<string, Diagnostic[]>();
  private proc: ChildProcess;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private docs = new Map<string, Doc>();
  private parsedWaiters = new Map<string, () => void>();
  private syncQueue: Promise<unknown> = Promise.resolve();
  private buffer = Buffer.alloc(0);
  private stderrTail = "";
  private markIndexed!: () => void;
  // The server sends workspace/inlayHint/refresh each time it publishes a project index.
  private indexed = new Promise<void>((resolve) => (this.markIndexed = resolve));
  exited = false;

  constructor(binary: string, root: string) {
    this.root = path.resolve(root);
    this.proc = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    // Keep only the tail: it is the useful part when the server dies, and the server logs a lot.
    this.proc.stderr!.on("data", (chunk: Buffer) => (this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000)));
    this.proc.on("error", (e) => this.fail(new LspError(`cannot start ${binary}: ${e.message}`)));
    // "close", not "exit": it fires after stderr is drained, so the tail is complete.
    this.proc.on("close", (code, signal) =>
      this.fail(new LspError(`lazyverilog-lsp exited (${signal ?? `code ${code}`})${this.stderrTail ? `:\n${this.stderrTail.trim()}` : ""}`)),
    );
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  private fail(error: Error): void {
    this.exited = true;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  async start(): Promise<void> {
    const rootUri = pathToUri(this.root);
    await this.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) }],
      capabilities: {
        general: { positionEncodings: ["utf-8"] },
        textDocument: { publishDiagnostics: {} },
        workspace: { workspaceEdit: { documentChanges: true } },
      },
    });
    this.notify("initialized", {});
    // No project, or a huge cold one: answer with what is indexed so far.
    await withTimeout(this.indexed, INDEX_TIMEOUT_MS);
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    try {
      await withTimeout(this.request("shutdown", null), 5000);
      this.notify("exit", null);
    } finally {
      setTimeout(() => this.proc.kill(), 1000).unref();
    }
  }

  private send(msg: object): void {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }));
    this.proc.stdin!.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const length = Number(/content-length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString())?.[1] ?? 0);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString();
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.dispatch(JSON.parse(body));
    }
  }

  private dispatch(msg: any): void {
    if (msg.method && msg.id !== undefined) {
      // Server->client request (registerCapability, configuration, refresh...): accept with defaults.
      if (msg.method === "workspace/inlayHint/refresh") this.markIndexed();
      const items = msg.params?.items;
      const result = msg.method === "workspace/configuration" && Array.isArray(items) ? items.map(() => null) : null;
      this.send({ id: msg.id, result });
    } else if (msg.method === "textDocument/publishDiagnostics") {
      const key = pathKey(uriToPath(msg.params.uri));
      this.diagnostics.set(key, msg.params.diagnostics);
      this.parsedWaiters.get(key)?.();
      this.parsedWaiters.delete(key);
    } else if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new LspError(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result ?? null);
    }
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    if (this.exited) return Promise.reject(new LspError("lazyverilog-lsp exited"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LspError(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v as T)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  command<T = any>(command: string, args: unknown[]): Promise<T> {
    return this.request<T>("workspace/executeCommand", { command, arguments: args });
  }

  /** Make the server's view of `file` match disk and wait for the parse. */
  async sync(file: string): Promise<{ uri: string; data: Buffer }> {
    const abs = path.resolve(file);
    const data = readFileSync(abs);
    const key = pathKey(abs);
    // Serialized so concurrent tool calls never open the same file twice.
    const step = this.syncQueue.then(() => {
      const known = this.docs.get(key);
      if (known && known.data.equals(data)) return { uri: known.uri, parsed: undefined };
      const parsed = new Promise<void>((resolve) => this.parsedWaiters.set(key, resolve));
      const text = data.toString("utf8");
      const doc = known ? { uri: known.uri, version: known.version + 1, data } : { uri: pathToUri(abs), version: 1, data };
      if (known) {
        this.notify("textDocument/didChange", { textDocument: { uri: doc.uri, version: doc.version }, contentChanges: [{ text }] });
      } else {
        this.notify("textDocument/didOpen", {
          textDocument: { uri: doc.uri, languageId: "systemverilog", version: doc.version, text },
        });
      }
      this.docs.set(key, doc);
      return { uri: doc.uri, parsed };
    });
    this.syncQueue = step.catch(() => {});
    const { uri, parsed } = await step;
    if (parsed) await withTimeout(parsed, PARSE_TIMEOUT_MS); // on timeout, answer from whatever the server has
    return { uri, data };
  }
}
