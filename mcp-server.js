#!/usr/bin/env node
/**
 * bounty-sanity-check MCP server (stdio).
 * Exposes check_bounty so a coding agent can verify a bounty is payable BEFORE
 * burning hours on it. This is the paid-distribution surface for the tool.
 */
const readline = require('readline');
const { checkBounty } = require('./index.js');

const TOOLS = [
  {
    name: 'check_bounty',
    description:
      'Check whether an open-source bounty is actually PAYABLE before working on it. '
      + 'Detects maintainer-cancelled bounty programs, already-paid bounties, closed issues '
      + 'still listed on boards, assigned issues, and competing open PRs. '
      + 'Returns a verdict (LIKELY_PAYABLE / STALE / CROWDED / CONTESTED / DEAD) with evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'GitHub issue URL, e.g. https://github.com/owner/repo/issues/123' },
        urls: { type: 'array', items: { type: 'string' }, description: 'Optional: check several at once.' },
      },
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'bounty-sanity-check', version: '1.0.0' },
      },
    };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const args = (params && params.arguments) || {};
    const urls = args.urls && args.urls.length ? args.urls : args.url ? [args.url] : [];
    if (!urls.length) {
      return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'Provide url or urls.' }] } };
    }
    const token = process.env.GITHUB_TOKEN || process.env.BOUNTYCHECK_GITHUB_TOKEN || null;
    const results = [];
    for (const u of urls.slice(0, 20)) {
      try { results.push(await checkBounty(u, { token })); }
      catch (err) { results.push({ url: u, verdict: 'ERROR', reasons: [err.message] }); }
    }
    const summary = results.map((r) =>
      `${r.verdict} (score ${r.score ?? '-'}) ${r.repo || ''}#${r.number || ''}\n`
      + (r.title ? `  ${r.title}\n` : '')
      + (r.reasons || []).map((x) => `  - ${x}`).join('\n')).join('\n\n');
    return {
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: summary }, { type: 'text', text: JSON.stringify(results) }] },
    };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  try {
    const res = await handle(req);
    if (res) send(res);
  } catch (err) {
    if (req.id !== undefined) send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: err.message } });
  }
});
