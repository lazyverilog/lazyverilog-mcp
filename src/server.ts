// MCP tools over lazyverilog-lsp (SystemVerilog).
//
// Positions are given as a 1-based line plus the symbol text on that line, so
// agents never have to count columns.  Edits are written to disk; pass
// `preview: true` to get a unified diff without writing.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FILE_HEADERS_ONLY, createTwoFilesPatch } from "diff";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { LspClient, applyTextEdits, pathKey, uriToPath, workspaceEditByPath, type Position, type WorkspaceEdit } from "./lsp.ts";

const SYMBOL_KINDS: Record<number, string> = {
  2: "module", 3: "package", 5: "class", 6: "method", 7: "property", 8: "field", 10: "enum",
  11: "interface", 12: "function", 13: "variable", 14: "constant", 22: "enum member",
  23: "struct", 24: "event", 26: "type parameter",
};
// Code actions whose command only previews; the matching command performs the edit.
const APPLY_COMMAND: Record<string, string> = {
  "lazyverilog.autoffPreview": "lazyverilog.autoffApply",
  "lazyverilog.autoffAllPreview": "lazyverilog.autoffAllApply",
  "lazyverilog.autowirepreview": "lazyverilog.autowire",
};

const root = () => process.env.LAZYVERILOG_ROOT || process.cwd();

function findBinary(): string {
  if (process.env.LAZYVERILOG_LSP) return process.env.LAZYVERILOG_LSP;
  const names = process.platform === "win32" ? ["lazyverilog-lsp.exe", "lazyverilog-lsp"] : ["lazyverilog-lsp"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter))
    for (const name of names) if (dir && existsSync(path.join(dir, name))) return path.join(dir, name);
  throw new Error("lazyverilog-lsp not found: put it on PATH or set LAZYVERILOG_LSP");
}

let clientPromise: Promise<LspClient> | undefined;
let current: LspClient | undefined;

export async function client(): Promise<LspClient> {
  if (!clientPromise || current?.exited) {
    clientPromise = (async () => {
      current = new LspClient(findBinary(), root());
      await current.start();
      return current;
    })();
    clientPromise.catch(() => (clientPromise = undefined));
  }
  return clientPromise;
}

export async function stopClient(): Promise<void> {
  const c = current;
  clientPromise = current = undefined;
  await c?.stop();
}

function abs(file: string): string {
  const p = path.resolve(root(), file);
  if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`no such file: ${p}`);
  return p;
}

function lineText(data: Buffer, line: number): string {
  const lines = data.toString("utf8").split("\n");
  if (line < 1 || line > lines.length) throw new Error(`line ${line} out of range (file has ${lines.length} lines)`);
  return lines[line - 1].replace(/\r$/, "");
}

/** 1-based line + symbol text -> LSP position (UTF-8 byte column). */
export function position(data: Buffer, line: number, symbol?: string, occurrence = 1): Position {
  const text = lineText(data, line);
  let col = 0;
  if (symbol) {
    const word = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let matches = [...text.matchAll(new RegExp(`(?<![\\w$])${word}(?![\\w$])`, "g"))];
    if (!matches.length) matches = [...text.matchAll(new RegExp(word, "g"))];
    if (matches.length < occurrence) throw new Error(`'${symbol}' not found on line ${line}: ${text.trim()}`);
    col = Buffer.byteLength(text.slice(0, matches[occurrence - 1].index));
  }
  return { line: line - 1, character: col };
}

/** Format a location as `path:line:col: source line` (1-based, character column). */
function loc(file: string, pos: Position, cache: Map<string, Buffer[]>): string {
  const key = pathKey(file);
  if (!cache.has(key)) {
    let lines: Buffer[] = [];
    try {
      const data = readFileSync(file);
      for (let start = 0, i = data.indexOf(10); ; i = data.indexOf(10, start)) {
        lines.push(data.subarray(start, i === -1 ? data.length : i));
        if (i === -1) break;
        start = i + 1;
      }
    } catch {
      lines = [];
    }
    cache.set(key, lines);
  }
  const src = (cache.get(key)![pos.line] ?? Buffer.alloc(0)).toString("utf8").replace(/\r$/, "");
  const col = Buffer.from(src).subarray(0, pos.character).toString("utf8").length + 1;
  return `${file}:${pos.line + 1}:${col}: ${src.trim()}`;
}

function locations(result: any): string[] {
  if (!result) return [];
  const cache = new Map<string, Buffer[]>();
  return (Array.isArray(result) ? result : [result]).map((l: any) =>
    loc(uriToPath(l.uri ?? l.targetUri), (l.range ?? l.targetSelectionRange).start, cache),
  );
}

/** Apply (or diff) a WorkspaceEdit against files on disk; resync changed files. */
async function applyWorkspaceEdit(edit: WorkspaceEdit | null | undefined, preview: boolean): Promise<string> {
  const diffs: string[] = [];
  const changed: Array<[string, Buffer]> = [];
  for (const [file, edits] of workspaceEditByPath(edit)) {
    const old = readFileSync(file);
    const updated = applyTextEdits(old, edits);
    if (updated.equals(old)) continue;
    const name = file.split(path.sep).join("/"); // jsdiff C-quotes names containing backslashes
    diffs.push(createTwoFilesPatch(name, name, old.toString("utf8"), updated.toString("utf8"), undefined, undefined, { headerOptions: FILE_HEADERS_ONLY }));
    changed.push([file, updated]);
  }
  if (!changed.length) return "No changes.";
  if (!preview) {
    const lsp = await client();
    for (const [file, data] of changed) {
      writeFileSync(file, data);
      await lsp.sync(file);
    }
  }
  return (preview ? "Preview (not written):\n" : `Applied to ${changed.length} file(s):\n`) + diffs.join("");
}

function formatDiagnostics(items: any[] | null): string {
  if (!items?.length) return "No diagnostics.";
  return items.map((d) => `${d.file}:${d.line}:${d.col}: ${String(d.severity).toLowerCase()}: ${d.message}`).join("\n");
}

async function at(file: string, line: number, symbol?: string, occurrence = 1) {
  const lsp = await client();
  const { uri, data } = await lsp.sync(abs(file));
  return { lsp, params: { textDocument: { uri }, position: position(data, line, symbol, occurrence) } as any };
}

function outline(symbols: any[], depth = 0): string[] {
  return symbols.flatMap((s) => {
    const range = s.selectionRange ?? s.range ?? s.location.range;
    const kind = SYMBOL_KINDS[s.kind] ?? String(s.kind);
    const detail = s.detail ? ` : ${s.detail}` : "";
    return [`${"  ".repeat(depth)}${kind} ${s.name}${detail}  (line ${range.start.line + 1})`, ...outline(s.children ?? [], depth + 1)];
  });
}

function treeLines(node: any, depth = 0): string[] {
  const name = node.inst ? `${node.inst}: ${node.name}` : node.name;
  const where = node.file ? `  (${uriToPath(node.file)}:${node.line})` : "";
  return [`${"  ".repeat(depth)}${name}${where}`, ...(node.children ?? []).flatMap((c: any) => treeLines(c, depth + 1))];
}

async function codeActionsAt(file: string, line: number, symbol?: string) {
  const { lsp, params } = await at(file, line, symbol);
  const pos: Position = params.position;
  const diags = (lsp.diagnostics.get(pathKey(abs(file))) ?? []).filter(
    (d) => d.range.start.line <= pos.line && pos.line <= d.range.end.line,
  );
  const actions: any[] =
    (await lsp.request("textDocument/codeAction", {
      textDocument: params.textDocument,
      range: { start: pos, end: pos },
      context: { diagnostics: diags },
    })) ?? [];
  return { lsp, actions };
}

// Tool implementations, exported for tests.
export const tools = {
  async lint({ file }: { file: string }) {
    const lsp = await client();
    const { uri } = await lsp.sync(abs(file));
    return formatDiagnostics(await lsp.command("lazyverilog.lint", [uri]));
  },

  async lint_all() {
    const lsp = await client();
    return formatDiagnostics(await lsp.command("lazyverilog.lintAll", []));
  },

  async format_file({ file, preview = false, start_line, end_line }: { file: string; preview?: boolean; start_line?: number; end_line?: number }) {
    const lsp = await client();
    const { uri } = await lsp.sync(abs(file));
    // Not textDocument/formatting: that is format-on-save and obeys enable_format_on_save.
    const args = start_line !== undefined ? [uri, "range", start_line - 1, end_line ?? start_line] : [uri, "full"];
    return applyWorkspaceEdit(await lsp.command("lazyverilog.format", args), preview);
  },

  async goto_definition({ file, line, symbol, occurrence = 1 }: { file: string; line: number; symbol: string; occurrence?: number }) {
    const { lsp, params } = await at(file, line, symbol, occurrence);
    return locations(await lsp.request("textDocument/definition", params)).join("\n") || "No definition found.";
  },

  async find_references({ file, line, symbol, occurrence = 1, include_declaration = true }: { file: string; line: number; symbol: string; occurrence?: number; include_declaration?: boolean }) {
    const { lsp, params } = await at(file, line, symbol, occurrence);
    params.context = { includeDeclaration: include_declaration };
    return locations(await lsp.request("textDocument/references", params)).join("\n") || "No references found.";
  },

  async hover({ file, line, symbol, occurrence = 1 }: { file: string; line: number; symbol: string; occurrence?: number }) {
    const { lsp, params } = await at(file, line, symbol, occurrence);
    const result = await lsp.request("textDocument/hover", params);
    if (!result) return "No hover info.";
    const value = (c: any) => (typeof c === "string" ? c : (c.value ?? ""));
    return Array.isArray(result.contents) ? result.contents.map(value).join("\n\n") : value(result.contents);
  },

  async rename_symbol({ file, line, symbol, new_name, occurrence = 1, preview = false }: { file: string; line: number; symbol: string; new_name: string; occurrence?: number; preview?: boolean }) {
    const { lsp, params } = await at(file, line, symbol, occurrence);
    params.newName = new_name;
    return applyWorkspaceEdit(await lsp.request("textDocument/rename", params), preview);
  },

  async document_symbols({ file }: { file: string }) {
    const lsp = await client();
    const { uri } = await lsp.sync(abs(file));
    return outline((await lsp.request("textDocument/documentSymbol", { textDocument: { uri } })) ?? []).join("\n") || "No symbols.";
  },

  async workspace_symbols({ query }: { query: string }) {
    const lsp = await client();
    const result: any[] = (await lsp.request("workspace/symbol", { query })) ?? [];
    const cache = new Map<string, Buffer[]>();
    return (
      result
        .map((s) => {
          const kind = SYMBOL_KINDS[s.kind] ?? String(s.kind);
          const file = uriToPath(s.location.uri);
          return `${kind} ${s.name}  ${s.location.range ? loc(file, s.location.range.start, cache) : file}`;
        })
        .join("\n") || "No symbols found."
    );
  },

  async rtl_tree({ file, reverse = false }: { file: string; reverse?: boolean }) {
    const lsp = await client();
    const { uri } = await lsp.sync(abs(file));
    const result = await lsp.command(reverse ? "lazyverilog.rtlTreeReverse" : "lazyverilog.rtlTree", [uri]);
    return result ? treeLines(result).join("\n") : "No RTL tree (no module found?).";
  },

  async code_actions({ file, line, symbol }: { file: string; line: number; symbol?: string }) {
    const { actions } = await codeActionsAt(file, line, symbol);
    return actions.map((a) => `- ${a.title}`).join("\n") || "No code actions here.";
  },

  async apply_code_action({ file, line, title, symbol, preview = false }: { file: string; line: number; title: string; symbol?: string; preview?: boolean }) {
    const { lsp, actions } = await codeActionsAt(file, line, symbol);
    const action =
      actions.find((a) => a.title === title) ?? actions.find((a) => a.title.toLowerCase().startsWith(title.toLowerCase()));
    if (!action) {
      const available = actions.map((a) => a.title).join(", ") || "none";
      return `No code action '${title}' at line ${line}. Available: ${available}`;
    }
    let edit: WorkspaceEdit | undefined = action.edit;
    const cmd = action.command;
    if (!edit && cmd?.command) {
      const result = await lsp.command(APPLY_COMMAND[cmd.command] ?? cmd.command, cmd.arguments ?? []);
      if (result?.changes || result?.documentChanges) edit = result;
      else if (result) return `${action.title}: ${JSON.stringify(result)}`;
    }
    return applyWorkspaceEdit(edit, preview);
  },
};

const file = z.string().describe("SystemVerilog file path, absolute or relative to the workspace root");
const line = z.number().int().min(1).describe("1-based line number");
const symbol = z.string().describe("Symbol text as written on that line");
const occurrence = z.number().int().min(1).optional().describe("Which occurrence on the line, if the symbol appears more than once (default 1)");
const preview = z.boolean().optional().describe("Return the diff without writing (default false)");

const TOOLS: Record<keyof typeof tools, { description: string; inputSchema: z.ZodRawShape }> = {
  lint: {
    description: "Lint one SystemVerilog file: parse errors, lint rules and semantic diagnostics. Output lines are `path:line:col: severity: message` (1-based).",
    inputSchema: { file },
  },
  lint_all: {
    description: "Lint every file in the project filelists (lazyverilog.toml [design]). Can be slow on big projects.",
    inputSchema: {},
  },
  format_file: {
    description: "Format a file with the project's lazyverilog.toml [format] rules. Give start_line/end_line (1-based, inclusive) to format only that range.",
    inputSchema: { file, preview, start_line: line.optional(), end_line: line.optional() },
  },
  goto_definition: {
    description: "Find where `symbol` (as written on `line` of `file`) is declared.",
    inputSchema: { file, line, symbol, occurrence },
  },
  find_references: {
    description: "List every reference to `symbol` (on `line` of `file`) across the project.",
    inputSchema: { file, line, symbol, occurrence, include_declaration: z.boolean().optional() },
  },
  hover: {
    description: "Show type/declaration info for `symbol` on `line` of `file`.",
    inputSchema: { file, line, symbol, occurrence },
  },
  rename_symbol: {
    description: "Rename `symbol` (on `line` of `file`) to `new_name` across the project.",
    inputSchema: { file, line, symbol, new_name: z.string(), occurrence, preview },
  },
  document_symbols: {
    description: "Outline of a file: modules, ports, signals, parameters, instances, functions... with line numbers.",
    inputSchema: { file },
  },
  workspace_symbols: {
    description: "Search project-wide for modules, interfaces, packages, classes, ... whose name matches `query`.",
    inputSchema: { query: z.string() },
  },
  rtl_tree: {
    description: "Module instance hierarchy rooted at the module in `file`: `instance: module  (path:line)`. reverse=true shows the parents that instantiate it instead.",
    inputSchema: { file, reverse: z.boolean().optional() },
  },
  code_actions: {
    description:
      "List RTL code actions available at `line` of `file`: AutoInst (on an instantiation line), AutoArg (module header), AutoFunc, AutoFF (always_ff), AutoWire, add default case, ... Pass `symbol` to place the cursor on it (e.g. the module name of an instance). Run one with apply_code_action.",
    inputSchema: { file, line, symbol: symbol.optional() },
  },
  apply_code_action: {
    description: "Run the code action named `title` (from code_actions, prefix match ok) at `line` of `file`.",
    inputSchema: { file, line, title: z.string(), symbol: symbol.optional(), preview },
  },
};

export function createServer(): McpServer {
  const server = new McpServer({ name: "lazyverilog", version: pkg.version });
  for (const [name, config] of Object.entries(TOOLS)) {
    const run = tools[name as keyof typeof tools] as (args: any) => Promise<string>;
    // Thrown errors become isError results carrying the message.
    server.registerTool(name, config, async (args: any) => ({ content: [{ type: "text" as const, text: await run(args) }] }));
  }
  return server;
}
