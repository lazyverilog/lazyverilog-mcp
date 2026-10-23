import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatLines, position, stopClient, tools } from "../src/server.ts";

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
// One file per code action, so the edits cannot interfere.
const FIXTURES: Record<string, string> = {
  "wire.sv": "module wire_top (input logic clk);\n  logic [7:0] din;\n  child u_wire (.clk(clk), .din(din), .dout(s_out));\nendmodule\n",
  "nonansi.sv": "module nonansi(a);\n  input  logic a;\n  input  logic b;\n  output logic c;\n  assign c = a & b;\nendmodule\n",
  "ff.sv": `module ff (input logic i_clk, input logic i_rst_n);
  logic [7:0] r_count, w_count;
  assign w_count = r_count + 8'd1;
  always_ff @(posedge i_clk or negedge i_rst_n) begin
    if (!i_rst_n) begin
    end else begin
    end
  end
endmodule
`,
  "func.sv": `module func;
  task add_number(input int a, input int b, output int result);
    result = a + b;
  endtask
  int x, y;
  initial begin
    add_number(x, y);
  end
endmodule
`,
  "bad.sv": "module bad;\n  logic a\nendmodule\n",
};

let dir: string;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "lvmcp-"));
  writeFileSync(path.join(dir, "child.sv"), CHILD);
  writeFileSync(path.join(dir, "top.sv"), TOP);
  writeFileSync(path.join(dir, "ugly.sv"), UNFORMATTED);
  for (const [name, text] of Object.entries(FIXTURES)) writeFileSync(path.join(dir, name), text);
  writeFileSync(path.join(dir, "files.f"), ["child.sv", "top.sv", "ugly.sv", ...Object.keys(FIXTURES)].join("\n") + "\n");
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
  assert.match(await tools.document_symbols({ file: "top.sv" }), /instance u_child : child {2}\(line 5\)/);
  assert.match(await tools.workspace_symbols({ query: "chi" }), /^module child .*child\.sv:1:8:/);
  assert.match(await tools.hover({ file: "top.sv", line: 5, symbol: "child" }), /output\s+logic \[7:0\]\s+dout/);
  assert.match(await tools.lint({ file: "child.sv" }), /No diagnostics\.|child\.sv/);
  assert.match(await tools.lint({ file: "bad.sv" }), /bad\.sv:2:\d+: error: expected ';'/);
  assert.match(await tools.lint_all(), /bad\.sv:2:\d+: error/);

  assert.match(await tools.format_file({ file: "ugly.sv", preview: true }), /^Preview/);
  assert.equal(read("ugly.sv"), UNFORMATTED);
  assert.match(await tools.format_file({ file: "ugly.sv" }), /^Applied/);
  assert.notEqual(read("ugly.sv"), UNFORMATTED);
  assert.equal(await tools.format_file({ file: "ugly.sv" }), "No changes."); // idempotent, and the server saw the write

  // Range format of line 3 only: the header on line 1 stays unformatted.
  writeFileSync(path.join(dir, "ugly.sv"), "module   ugly(input logic a,output logic b);\n  logic x;\nassign b=a;\nendmodule\n");
  assert.match(await tools.format_file({ file: "ugly.sv", start_line: 3 }), /^Applied/);
  assert.equal(read("ugly.sv"), "module   ugly(input logic a,output logic b);\n  logic x;\n  assign b = a;\nendmodule\n");

  assert.match(await tools.rename_symbol({ file: "top.sv", line: 4, symbol: "b", new_name: "bb" }), /^Applied/);
  assert.match(read("top.sv"), /bb/);

  assert.match(await tools.code_actions({ file: "top.sv", line: 5, symbol: "child" }), /AutoInst/);
  assert.match(await tools.rtl_tree({ file: "top.sv" }), /u_child: child/);
  assert.match(await tools.rtl_tree({ file: "child.sv", reverse: true }), /u_child: top/);

  const act = (file: string, line: number, title: string, symbol?: string) => tools.apply_code_action({ file, line, title, symbol });
  assert.match(await act("top.sv", 5, "AutoInst", "child"), /^Applied/);
  assert.match(read("top.sv"), /\.din\s*\(a\s*\)/);
  assert.match(await act("wire.sv", 3, "AutoWire"), /^Applied/);
  assert.match(read("wire.sv"), /logic \[7:0\] s_out;/);
  assert.match(await act("nonansi.sv", 1, "AutoArg", "nonansi"), /^Applied/);
  assert.match(read("nonansi.sv"), /a,\s*b,\s*c\s*\);/);
  assert.match(await act("ff.sv", 2, "AutoFF:", "r_count"), /^Applied/);
  assert.match(read("ff.sv"), /begin\n\s*r_count <= '0;\n\s*end else begin\n\s*r_count <= w_count;/);
  assert.equal(await act("ff.sv", 2, "AutoFF All", "r_count"), "No changes."); // already assigned
  assert.match(await act("func.sv", 7, "AutoFunc", "add_number"), /^Applied/);
  assert.match(read("func.sv"), /add_number\(\.a\(x\), \.b\(y\), \.result\(result\)\);/);
  assert.match(await act("func.sv", 6, "Insert always_ff"), /^Applied/);
  assert.match(read("func.sv"), /always_ff/);
  assert.match(await act("top.sv", 5, "nope", "child"), /^No code action 'nope'.*Available: AutoInst/);
  await assert.rejects(tools.hover({ file: "top.sv", line: 5, symbol: "nope" }), /not found on line 5/);
});

test("formatLines keeps only changes in the range", () => {
  const old = "a\nb\nc\nd\ne\n";
  const formatted = "A\nb\nC\nC2\nd\nE\n";
  assert.equal(formatLines(old, formatted, 3, 3), "a\nb\nC\nC2\nd\ne\n");
  assert.equal(formatLines(old, formatted, 1, 5), formatted);
  assert.equal(formatLines(old, formatted, 2, 2), old);
  assert.equal(formatLines("a\nb\n", "a\nx\nb\n", 2, 2), "a\nx\nb\n"); // pure insertion before line 2
});

test("position by symbol", () => {
  const data = Buffer.from("  foo bar_foo foo\r\n");
  assert.deepEqual(position(data, 1, "foo"), { line: 0, character: 2 });
  assert.deepEqual(position(data, 1, "foo", 2), { line: 0, character: 14 });
  assert.deepEqual(position(Buffer.from("é foo"), 1, "foo"), { line: 0, character: 3 }); // UTF-8 bytes
  assert.throws(() => position(data, 1, "baz"));
});
