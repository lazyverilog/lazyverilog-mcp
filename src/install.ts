// Keeps the latest lazyverilog-lsp release in a per-user cache, so every user runs the newest server.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const RELEASES = "https://github.com/lazyverilog/LazyVerilog/releases";

// Static Linux builds need no system libraries.
const ASSET_SUFFIX: Record<string, string> = {
  "linux-x64": "linux-x64-static",
  "linux-arm64": "linux-arm64-static",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "win32-x64": "windows-x64.exe",
};

export function cacheDir(): string {
  const base =
    process.env.XDG_CACHE_HOME || (process.platform === "win32" && process.env.LOCALAPPDATA) || path.join(os.homedir(), ".cache");
  return path.join(base, "lazyverilog-mcp");
}

// The /latest page redirects to /tag/<tag>; unlike the REST API it has no rate limit.
async function latestTag(): Promise<string> {
  const res = await fetch(`${RELEASES}/latest`, { redirect: "manual", signal: AbortSignal.timeout(5000) });
  const tag = res.headers.get("location")?.match(/\/tag\/([^/]+)$/)?.[1];
  if (!tag) throw new Error(`no latest release (HTTP ${res.status})`);
  return tag;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Path of the latest lazyverilog-lsp, downloaded on first use. Offline: the newest cached copy. */
export async function latestBinary(): Promise<string | undefined> {
  const suffix = ASSET_SUFFIX[`${process.platform}-${process.arch}`];
  if (!suffix) return undefined;
  const dir = cacheDir();
  const cached = () => (existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("lazyverilog-lsp-") && f.endsWith(suffix)) : []);

  let tag: string;
  try {
    tag = await latestTag();
  } catch {
    return cached()
      .map((f) => path.join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  }

  const name = `lazyverilog-lsp-${tag}-${suffix}`;
  const file = path.join(dir, name);
  if (existsSync(file)) return file;

  process.stderr.write(`[lazyverilog-mcp] downloading ${name}\n`);
  const url = `${RELEASES}/download/${tag}/${name}`;
  const [bin, sum] = await Promise.all([download(url), download(`${url}.sha256`)]);
  if (createHash("sha256").update(bin).digest("hex") !== sum.toString("utf8").trim().split(/\s+/)[0])
    throw new Error(`${name}: checksum mismatch`);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, bin, { mode: 0o755 });
  renameSync(tmp, file);
  for (const old of cached())
    if (old !== name)
      try {
        rmSync(path.join(dir, old));
      } catch {} // still running in another session
  return file;
}
