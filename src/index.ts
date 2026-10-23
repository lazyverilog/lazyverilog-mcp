#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, stopClient } from "./server.ts";

await createServer().connect(new StdioServerTransport());
process.stdin.on("close", () => void stopClient().finally(() => process.exit(0)));
