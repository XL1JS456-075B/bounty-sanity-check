#!/usr/bin/env node
// Entry point: `--mcp` starts the MCP stdio server, otherwise run the CLI.
if (process.argv.includes('--mcp')) {
  require('./mcp-server.js');
} else {
  const { runCli } = require('./index.js');
  runCli(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
}
