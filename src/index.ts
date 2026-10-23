#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, stopClient } from "./server.ts";

await createServer().connect(new StdioServerTransport());
// No process.exit(): it can drop stdout still queued for a pipe. Node exits once the LSP child is gone.
process.stdin.on("close", () => void stopClient());
