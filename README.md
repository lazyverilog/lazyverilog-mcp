<p align="center">
  <img src="https://raw.githubusercontent.com/lazyverilog/LazyVerilog/main/docs/public/logo.webp" alt="LazyVerilog logo" width="260">
</p>

<h1 align="center">🤖 LazyVerilog MCP</h1>

<p align="center">
  <b>The LazyVerilog SystemVerilog LSP, for AI coding agents.</b>
</p>

<p align="center">
  <a href="https://github.com/lazyverilog/lazyverilog-mcp/actions/workflows/ci.yml"><img src="https://github.com/lazyverilog/lazyverilog-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/lazyverilog-mcp"><img src="https://img.shields.io/npm/v/lazyverilog-mcp?logo=npm&color=cb3837" alt="npm"></a>
</p>

<p align="center">
  <a href="https://github.com/lazyverilog/lazyverilog-mcp/stargazers">
    <img alt="GitHub stars" src="https://img.shields.io/github/stars/lazyverilog/lazyverilog-mcp?style=for-the-badge&logo=starship&label=%E2%AD%90%20Stars&color=ffd166&labelColor=2b2d42">
  </a>
  <a href="https://github.com/lazyverilog/lazyverilog-mcp/issues">
    <img alt="GitHub issues" src="https://img.shields.io/github/issues/lazyverilog/lazyverilog-mcp?style=for-the-badge">
  </a>
  <a href="https://github.com/sponsors/kjoonha">
    <img alt="Sponsor kjoonha" src="https://img.shields.io/badge/Sponsor-kjoonha-ea4aaa?style=for-the-badge&logo=githubsponsors&logoColor=white&labelColor=2b2d42">
  </a>
</p>

<p align="center">
  <a href="#-demo">Demo</a>
  ·
  <a href="#-tools">Tools</a>
  ·
  <a href="#-getting-started">Getting Started</a>
  ·
  <a href="#%EF%B8%8F-configuration">Configuration</a>
</p>

<p align="center">
  LazyVerilog MCP is an MCP server for Claude Code, Codex, Cursor, and other AI agents.
  It runs the <a href="https://github.com/lazyverilog/LazyVerilog">LazyVerilog</a> LSP and gives the agent
  lint, formatting, navigation, rename, RTL tree, and RTL code actions (AutoInst, AutoWire, AutoArg, AutoFF, AutoFunc) on real SystemVerilog projects.
</p>

<p align="center">
  <sub>If LazyVerilog saves you time, a ⭐ helps other RTL engineers find it.</sub>
</p>

&nbsp;

## 🎬 Demo

<details>
<summary><b>🧩 Auto-instantiation</b></summary>

> Run AutoInst on the `child` instance at line 4 of `top.sv`.

```diff
 module top (
     input logic clk
 );
-  child u_child ();
+  child u_child(
+    .clk(clk),
+    .din(din),
+    .dout(dout)
+  );
 endmodule
```

</details>

<details>
<summary><b>💡 Hover</b></summary>

> What is `child` on line 4 of `top.sv`?

```
module child
  input   logic        clk
  input   logic [7:0]  din
  output  logic [7:0]  dout
```

</details>

<details>
<summary><b>🌳 RTL tree</b></summary>

> Show the hierarchy under `top.sv`.

```
top  (rtl/top.sv:1)
  u_child: child  (rtl/child.sv:1)
```

</details>

<details>
<summary><b>🚨 Lint diagnostics</b></summary>

> Lint `rtl/top.sv`.

```
rtl/top.sv:7:34: error: expected ';'
```

</details>

&nbsp;

## 📊 Tools

The tools the agent gets:

| Tool | What it does |
|------|--------------|
| `lint` | Parse, lint, and semantic diagnostics for one file |
| `lint_all` | Diagnostics for every file in the project filelists |
| `format_file` | Format a whole file or a line range with your `lazyverilog.toml` rules |
| `goto_definition` | Declaration of a module, instance, port, signal, or macro |
| `find_references` | Every reference across the project |
| `hover` | Type and declaration details |
| `rename_symbol` | Project-wide rename |
| `document_symbols` | File outline with line numbers |
| `workspace_symbols` | Find modules, interfaces, packages, and classes by name |
| `rtl_tree` | Instance hierarchy below (or above) a module |
| `code_actions` | List AutoInst / AutoArg / AutoFunc / AutoFF / AutoWire / ... at a line |
| `apply_code_action` | Run one of them |

Positions are a 1-based line plus the symbol text on that line, so the agent never counts columns.
Editing tools write to disk. With `preview: true` they return a unified diff instead.

&nbsp;

## 🚀 Getting Started

### 1. Install Node.js

Node.js 20 or newer: <https://nodejs.org>. Check with `node --version`.

### 2. Install `lazyverilog-lsp`

Download the server binary for your platform from the
[latest LazyVerilog release](https://github.com/lazyverilog/LazyVerilog/releases/latest):

| Platform | Asset |
|----------|-------|
| Linux x64 | `lazyverilog-lsp-<version>-linux-x64` (or `-linux-x64-static` if libraries are missing) |
| Linux arm64 | `lazyverilog-lsp-<version>-linux-arm64` (or `-linux-arm64-static`) |
| macOS Apple Silicon | `lazyverilog-lsp-<version>-darwin-arm64` |
| macOS Intel | `lazyverilog-lsp-<version>-darwin-x64` |
| Windows x64 | `lazyverilog-lsp-<version>-windows-x64.exe` |

Rename it to `lazyverilog-lsp` (`lazyverilog-lsp.exe` on Windows) and put it on your `PATH`.
Example for Linux x64:

```bash
VERSION=v2.1.2
curl -fLo ~/.local/bin/lazyverilog-lsp \
  https://github.com/lazyverilog/LazyVerilog/releases/download/$VERSION/lazyverilog-lsp-$VERSION-linux-x64
chmod +x ~/.local/bin/lazyverilog-lsp
lazyverilog-lsp --version
```

On macOS, if Gatekeeper blocks the binary, run `xattr -d com.apple.quarantine <path>`.
If you do not want it on `PATH`, set `LAZYVERILOG_LSP` to its full path in the agent configuration below.
To build it yourself, see [Build from source](https://lazyverilog.github.io/installation/#build-from-source).

### 3. Add a `lazyverilog.toml` to your project

The server finds project files and settings through a `lazyverilog.toml` at the project root:

```toml
[design]
vcode = "files.f"   # filelist of your RTL sources
```

All options: **https://lazyverilog.github.io**

### 4. Register the MCP server with your agent

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add lazyverilog --scope user -- npx -y lazyverilog-mcp
```

`--scope user` enables it in every project. `--scope project` writes a shared `.mcp.json` into the
current repository instead. To pass the binary path:

```bash
claude mcp add lazyverilog --scope user -e LAZYVERILOG_LSP=/path/to/lazyverilog-lsp -- npx -y lazyverilog-mcp
```

On native Windows (not WSL), wrap `npx` with `cmd /c`:

```bash
claude mcp add lazyverilog --scope user -- cmd /c npx -y lazyverilog-mcp
```

Check it with `claude mcp list`, or `/mcp` inside a session.

</details>

<details>
<summary><b>Codex</b></summary>

`~/.codex/config.toml`:

```toml
[mcp_servers.lazyverilog]
command = "npx"
args = ["-y", "lazyverilog-mcp"]
# env = { LAZYVERILOG_LSP = "/path/to/lazyverilog-lsp" }
```

</details>

<details>
<summary><b>Cursor, Claude Desktop, and other clients</b></summary>

`mcpServers` JSON:

```json
{
  "mcpServers": {
    "lazyverilog": {
      "command": "npx",
      "args": ["-y", "lazyverilog-mcp"],
      "env": { "LAZYVERILOG_LSP": "/path/to/lazyverilog-lsp" }
    }
  }
}
```

</details>

Start the agent from your project directory, or set `LAZYVERILOG_ROOT`.

### 5. Try it

- "Lint `rtl/top.sv` with lazyverilog."
- "Where is `u_fifo` on line 42 of `rtl/top.sv` defined?"
- "Run AutoInst on the instance at line 30 of `rtl/top.sv`."

&nbsp;

## ⚙️ Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `LAZYVERILOG_LSP` | `lazyverilog-lsp` on `PATH` | LSP binary |
| `LAZYVERILOG_ROOT` | current directory | Workspace root; relative file paths resolve against it |
| `LAZYVERILOG_INDEX_TIMEOUT` | `30` | Seconds the first call waits for the project index |

Formatting, lint rules, and code-action behavior come from the project's `lazyverilog.toml`, as in the editor plugins.
Project-wide answers (references, workspace symbols, AutoInst of modules in other files) depend on the
background index. On a large project it can still be building for some seconds after the first call.

&nbsp;

## 🩺 Troubleshooting

- **`lazyverilog-lsp not found`**: put the binary on `PATH` or set `LAZYVERILOG_LSP`.
- **`lazyverilog-lsp exited`**: run `lazyverilog-lsp --version` in a terminal to see why it does not start.
  A MinGW-built binary on Windows needs the MinGW runtime DLLs (`libstdc++-6.dll`, ...) on `PATH`.
- **No cross-file results**: check that `lazyverilog.toml` is at the project root and its filelist lists the files.

&nbsp;

## 🛠️ Development

```bash
git clone https://github.com/lazyverilog/lazyverilog-mcp
cd lazyverilog-mcp
npm install        # also builds dist/index.js
npm test           # Node >= 22.18; drives a real lazyverilog-lsp, skipped if not found
npm run typecheck
```

To use a local checkout, point the agent at `node /path/to/lazyverilog-mcp/dist/index.js`.

To release, bump the version on `main` and push the tag:

```bash
npm version patch   # or minor / major: commits and tags vX.Y.Z
git push --follow-tags
```

The [Release workflow](.github/workflows/release.yml) publishes the tag to npm through trusted publishing
and creates the GitHub release.

## 📄 License

MIT
