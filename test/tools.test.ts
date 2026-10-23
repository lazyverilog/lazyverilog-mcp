import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { position, stopClient, tools } from "../src/server.ts";

function findLsp(): string | undefined {
  if (process.env.LAZYVERILOG_LSP) return process.env.LAZYVERILOG_LSP;
  const exe = process.platform === "win32" ? "lazyverilog-lsp.exe" : "lazyverilog-lsp";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) if (dir && existsSync(path.join(dir, exe))) return path.join(dir, exe);
  const sibling = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../lazyverilog/build");
  return existsSync(sibling) ? readdirSync(sibling).map((f) => path.join(sibling, f)).find((f) => path.basename(f) === exe) : undefined;
}

const LSP = findLsp();

const CHILD = `module child (
    input  logic       clk,
    input  logic [7:0] din,
    output logic [7:0] dout
);
  always_ff @(posedge clk) dout <= din;
endmodule
`;
const TOP = `module top (
    input logic clk
);
  logic [7:0] a, b;
  child u_child (.clk(clk), .din(a), .dout(b));
  assign a = b + 8'd1;
endmodule
`;
const UNFORMATTED = "module   ugly(input logic a,output logic b);\nassign b=a;\nendmodule\n";

let dir: string;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "lvmcp-"));
  writeFileSync(path.join(dir, "child.sv"), CHILD);
  writeFileSync(path.join(dir, "top.sv"), TOP);
  writeFileSync(path.join(dir, "ugly.sv"), UNFORMATTED);
  writeFileSync(path.join(dir, "files.f"), "child.sv\ntop.sv\nugly.sv\n");
  writeFileSync(path.join(dir, "lazyverilog.toml"), '[design]\nvcode = "files.f"\n');
  if (LSP) process.env.LAZYVERILOG_LSP = LSP;
  process.env.LAZYVERILOG_ROOT = dir;
});

after(async () => {
  await stopClient();
  rmSync(dir, { recursive: true, force: true });
});

test("tools end to end", { skip: !LSP && "lazyverilog-lsp not found" }, async () => {
  const read = (f: string) => readFileSync(path.join(dir, f), "utf8");

  assert.match(await tools.goto_definition({ file: "top.sv", line: 5, symbol: "child" }), /child\.sv:1:/);
  assert.ok((await tools.find_references({ file: "top.sv", line: 4, symbol: "a" })).split("top.sv").length > 2);
  assert.match(await tools.document_symbols({ file: "top.sv" }), /top/);
  assert.match(await tools.lint({ file: "child.sv" }), /No diagnostics\.|child\.sv/);

  assert.match(await tools.format_file({ file: "ugly.sv", preview: true }), /^Preview/);
  assert.equal(read("ugly.sv"), UNFORMATTED);
  assert.match(await tools.format_file({ file: "ugly.sv" }), /^Applied/);
  assert.notEqual(read("ugly.sv"), UNFORMATTED);
  assert.equal(await tools.format_file({ file: "ugly.sv" }), "No changes."); // idempotent, and the server saw the write

  assert.match(await tools.rename_symbol({ file: "top.sv", line: 4, symbol: "b", new_name: "bb" }), /^Applied/);
  assert.match(read("top.sv"), /bb/);

  assert.match(await tools.code_actions({ file: "top.sv", line: 5, symbol: "child" }), /AutoInst/);
  assert.match(await tools.rtl_tree({ file: "top.sv" }), /u_child: child/);
  await assert.rejects(tools.hover({ file: "top.sv", line: 5, symbol: "nope" }), /not found on line 5/);
});

test("position by symbol", () => {
  const data = Buffer.from("  foo bar_foo foo\r\n");
  assert.deepEqual(position(data, 1, "foo"), { line: 0, character: 2 });
  assert.deepEqual(position(data, 1, "foo", 2), { line: 0, character: 14 });
  assert.deepEqual(position(Buffer.from("é foo"), 1, "foo"), { line: 0, character: 3 }); // UTF-8 bytes
  assert.throws(() => position(data, 1, "baz"));
});
