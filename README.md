# lazyverilog-mcp

MCP server that gives AI coding agents (Claude Code, Codex, Cursor, ...) the
[LazyVerilog](https://github.com/lazyverilog/LazyVerilog) SystemVerilog LSP:
lint, format, go-to-definition, references, hover, rename, symbols, RTL tree,
and RTL code actions (AutoInst, AutoArg, AutoFunc, AutoFF, AutoWire).

It starts `lazyverilog-lsp` as a child process and talks LSP to it. Files are
read from disk on every call, so the server always sees the agent's edits.

## Installation

### 1. Install Node.js

Node.js 20 or newer: <https://nodejs.org>. Check with `node --version`.

### 2. Install `lazyverilog-lsp`

Download the server binary for your platform from the
[latest LazyVerilog release](https://github.com/lazyverilog/LazyVerilog/releases/latest):

| Platform | Asset |
|---|---|
| Linux x64 | `lazyverilog-lsp-<version>-linux-x64` (or `-linux-x64-static` if libraries are missing) |
| Linux arm64 | `lazyverilog-lsp-<version>-linux-arm64` (or `-linux-arm64-static`) |
| macOS Apple Silicon | `lazyverilog-lsp-<version>-darwin-arm64` |
| macOS Intel | `lazyverilog-lsp-<version>-darwin-x64` |
| Windows x64 | `lazyverilog-lsp-<version>-windows-x64.exe` |

Rename it to `lazyverilog-lsp` (`lazyverilog-lsp.exe` on Windows) and put it on
your `PATH`. Example for Linux x64:

```bash
VERSION=v2.1.1
curl -fLo ~/.local/bin/lazyverilog-lsp \
  https://github.com/lazyverilog/LazyVerilog/releases/download/$VERSION/lazyverilog-lsp-$VERSION-linux-x64
chmod +x ~/.local/bin/lazyverilog-lsp
lazyverilog-lsp --version
```

On macOS, if Gatekeeper blocks the binary, run `xattr -d com.apple.quarantine <path>`.

If you do not want it on `PATH`, set `LAZYVERILOG_LSP` to its full path in the
agent configuration below. To build it from source instead, see
[Build from source](https://lazyverilog.github.io/installation/#build-from-source).

### 3. Add a `lazyverilog.toml` to your project

The server finds project files and settings through a `lazyverilog.toml` at the
project root. Minimal example:

```toml
[design]
vcode = "files.f"   # filelist of your RTL sources
```

See the [LazyVerilog configuration docs](https://lazyverilog.github.io) for all options.

### 4. Register the MCP server with your agent

The package is installed from GitHub with `npx`. The first start builds it, so
it takes a few seconds longer. `--allow-git=all` is needed because npm 12
refuses packages fetched from git by default.

**Claude Code**

```bash
claude mcp add lazyverilog --scope user -- npx -y --allow-git=all github:lazyverilog/lazyverilog-mcp
```

`--scope user` enables it in every project. Use `--scope project` to write a
shared `.mcp.json` into the current repository instead. To pass the binary
path:

```bash
claude mcp add lazyverilog --scope user -e LAZYVERILOG_LSP=/path/to/lazyverilog-lsp -- npx -y --allow-git=all github:lazyverilog/lazyverilog-mcp
```

On native Windows (not WSL), wrap `npx` with `cmd /c`:

```bash
claude mcp add lazyverilog --scope user -- cmd /c npx -y --allow-git=all github:lazyverilog/lazyverilog-mcp
```

Check it with `claude mcp list`, or `/mcp` inside a session.

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.lazyverilog]
command = "npx"
args = ["-y", "--allow-git=all", "github:lazyverilog/lazyverilog-mcp"]
# env = { LAZYVERILOG_LSP = "/path/to/lazyverilog-lsp" }
```

**Cursor, Claude Desktop, and other clients** (`mcpServers` JSON)

```json
{
  "mcpServers": {
    "lazyverilog": {
      "command": "npx",
      "args": ["-y", "--allow-git=all", "github:lazyverilog/lazyverilog-mcp"],
      "env": { "LAZYVERILOG_LSP": "/path/to/lazyverilog-lsp" }
    }
  }
}
```

Start the agent from your project directory, or set `LAZYVERILOG_ROOT`.

### 5. Try it

Ask the agent, for example:

- "Lint `rtl/top.sv` with lazyverilog."
- "Where is `u_fifo` in `rtl/top.sv` line 42 defined?"
- "Run AutoInst on the instance at line 30 of `rtl/top.sv`."

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `LAZYVERILOG_LSP` | `lazyverilog-lsp` on `PATH` | LSP binary |
| `LAZYVERILOG_ROOT` | current directory | workspace root; relative file paths resolve against it |
| `LAZYVERILOG_INDEX_TIMEOUT` | `30` | seconds the first call waits for the project index |

Formatting, lint rules, and code-action behavior come from the project's
`lazyverilog.toml`, as in the editor plugins.

## Tools

Positions are a 1-based `line` plus the `symbol` text on that line (and
`occurrence` if it appears more than once), so the agent never counts columns.
Editing tools write to disk. Pass `preview: true` to get a unified diff instead.

| Tool | What it does |
|---|---|
| `lint(file)` | parse, lint and semantic diagnostics for one file |
| `lint_all()` | diagnostics for every file in the project filelists |
| `format_file(file, preview?, start_line?, end_line?)` | format the whole file or a line range |
| `goto_definition(file, line, symbol)` | declaration location |
| `find_references(file, line, symbol)` | all references in the project |
| `hover(file, line, symbol)` | type / declaration info |
| `rename_symbol(file, line, symbol, new_name, preview?)` | project-wide rename |
| `document_symbols(file)` | outline with line numbers |
| `workspace_symbols(query)` | find modules/interfaces/packages by name |
| `rtl_tree(file, reverse?)` | instance hierarchy below (or above) the module |
| `code_actions(file, line, symbol?)` | list AutoInst/AutoArg/AutoFunc/AutoFF/AutoWire/... at a line |
| `apply_code_action(file, line, title, symbol?, preview?)` | run one of them |

Project-wide answers (references, workspace symbols, AutoInst of modules in
other files) depend on the background index. On a large project it can still
be building for some seconds after the first call.

## Troubleshooting

- **`lazyverilog-lsp not found`**: put the binary on `PATH` or set `LAZYVERILOG_LSP`.
- **`lazyverilog-lsp exited`**: run `lazyverilog-lsp --version` in a terminal to
  see why it does not start. A MinGW-built binary on Windows needs the MinGW
  runtime DLLs (`libstdc++-6.dll`, ...) on `PATH`.
- **No cross-file results**: check that `lazyverilog.toml` is at the project
  root and its filelist lists the files.

## Development

```bash
git clone https://github.com/lazyverilog/lazyverilog-mcp
cd lazyverilog-mcp
npm install        # also builds dist/index.js
npm test           # Node >= 22.18; drives a real lazyverilog-lsp, skipped if not found
npm run typecheck
```

To use a local checkout, point the agent at `node /path/to/lazyverilog-mcp/dist/index.js`.

## License

MIT
