#!/usr/bin/env node
/**
 * bounty-sanity-check — decide whether an open-source bounty is actually PAYABLE
 * before you spend hours on it.
 *
 * Built because Algora/IssueHunt boards keep advertising bounties that cannot pay:
 * the maintainer cancelled the program, the issue is already solved, or 40 agents
 * are racing the same $30. This checks the evidence that actually predicts payout.
 *
 * Pure Node, no deps. Exported for the Apify actor + MCP server wrappers.
 */

const KILL_PHRASES = [
  // Maintainer says the money is gone. Highest-signal check in the whole tool.
  /we (?:have )?stopped the bounty program/i,
  /no longer (?:part of|participating in|using) (?:the )?(?:algora|bounty)/i,
  /payouts? (?:won'?t|will not|cannot) (?:work|happen)/i,
  /we don'?t accept any bounty claims/i,
  /bounty (?:program|programme) (?:is )?(?:cancelled|canceled|discontinued|ended|over)/i,
  /asked (?:them|algora) to remove/i,
  /don'?t expect a payout/i,
  /this bounty is (?:no longer|not) (?:valid|available|active)/i,
];

const PAID_PHRASES = [
  /the bounty has been (?:paid|awarded|claimed)/i,
  /💰 .*(?:rewarded|awarded|paid)/i,
  /has been awarded to/i,
  /bounty.*(?:successfully )?(?:paid out|rewarded)/i,
];

const ATTEMPT_RE = /\/attempt\s+#?\d+/i;
const CLAIM_RE = /\/claim\s+#?\d+/i;
const ALGORA_BOUNTY_RE = /\$\s?([\d,]+(?:\.\d+)?)\s*bounty/i;

const MAINTAINER_ASSOC = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function parseIssueUrl(url) {
  const m = String(url).match(/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/);
  if (!m) throw new Error('Not a GitHub issue URL: ' + url);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

function makeClient(token, fetchImpl = globalThis.fetch) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'bounty-sanity-check',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = 'Bearer ' + token;
  return async function api(path) {
    const res = await fetchImpl('https://api.github.com' + path, { headers });
    if (res.status === 403 || res.status === 429) {
      const reset = res.headers.get('x-ratelimit-reset');
      const err = new Error('github_rate_limited');
      err.rateLimited = true;
      err.resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : null;
      throw err;
    }
    if (res.status === 404) {
      const err = new Error('not_found');
      err.notFound = true;
      throw err;
    }
    if (!res.ok) throw new Error('github_http_' + res.status);
    return res.json();
  };
}

async function paginate(api, path, max = 300) {
  const out = [];
  for (let page = 1; out.length < max; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const batch = await api(`${path}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

function daysSince(iso) {
  if (!iso) return null;
  return Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
}

/** Core check. Returns a verdict object with evidence — never a bare boolean. */
async function checkBounty(url, { token, fetchImpl } = {}) {
  const { owner, repo, number } = parseIssueUrl(url);
  const api = makeClient(token, fetchImpl);
  const slug = `${owner}/${repo}`;

  let issue;
  try {
    issue = await api(`/repos/${slug}/issues/${number}`);
  } catch (err) {
    if (err.notFound) {
      return {
        url, repo: slug, number,
        verdict: 'NOT_FOUND', confidence: 'high', score: 0,
        reasons: ['Issue does not exist or the repo is private/deleted.'],
        evidence: {}, checked_at: new Date().toISOString(),
      };
    }
    throw err;
  }

  const comments = await paginate(api, `/repos/${slug}/issues/${number}/comments`);

  // --- evidence gathering -------------------------------------------------
  const killed = [];
  const paidOut = [];
  let attempts = 0;
  let claims = 0;
  let bountyAmount = null;
  let algoraBotPresent = false;

  for (const c of comments) {
    const body = c.body || '';
    const login = (c.user && c.user.login) || '';
    const assoc = c.author_association || '';
    if (ATTEMPT_RE.test(body)) attempts += 1;
    if (CLAIM_RE.test(body)) claims += 1;
    if (/^algora-pbc(\[bot\])?$/i.test(login)) {
      algoraBotPresent = true;
      const m = body.match(ALGORA_BOUNTY_RE);
      if (m && bountyAmount == null) bountyAmount = Number(m[1].replace(/,/g, ''));
    }
    // A cancellation only counts from someone who can actually speak for the repo.
    if (MAINTAINER_ASSOC.has(assoc) && KILL_PHRASES.some((re) => re.test(body))) {
      killed.push({ login, assoc, at: c.created_at, quote: body.replace(/\s+/g, ' ').slice(0, 240) });
    }
    if (PAID_PHRASES.some((re) => re.test(body))) {
      paidOut.push({ login, at: c.created_at, quote: body.replace(/\s+/g, ' ').slice(0, 160) });
    }
  }

  // Competing open PRs that reference this issue number.
  let competingPrs = [];
  let prSearchFailed = false;
  try {
    const q = encodeURIComponent(`repo:${slug} is:pr is:open ${number}`);
    const found = await api(`/search/issues?q=${q}&per_page=20`);
    competingPrs = (found.items || [])
      .filter((p) => {
        const hay = `${p.title} ${p.body || ''}`;
        return new RegExp(`#${number}\\b`).test(hay);
      })
      .map((p) => ({ number: p.number, title: p.title.slice(0, 90), user: p.user.login, created_at: p.created_at }));
  } catch (err) {
    prSearchFailed = true;
  }

  const evidence = {
    state: issue.state,
    state_reason: issue.state_reason || null,
    assignee: (issue.assignee && issue.assignee.login) || null,
    labels: (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
    comment_count: comments.length,
    attempt_comments: attempts,
    claim_comments: claims,
    algora_bot_present: algoraBotPresent,
    advertised_bounty_usd: bountyAmount,
    competing_open_prs: competingPrs,
    competing_pr_search_failed: prSearchFailed,
    maintainer_cancellation: killed,
    payout_announcements: paidOut,
    created_days_ago: daysSince(issue.created_at),
    updated_days_ago: daysSince(issue.updated_at),
  };

  // --- verdict ------------------------------------------------------------
  const reasons = [];
  let verdict = 'LIKELY_PAYABLE';
  let confidence = 'medium';

  if (issue.state === 'closed') {
    verdict = 'DEAD';
    confidence = 'high';
    reasons.push(`Issue is closed (${issue.state_reason || 'no reason given'}). Boards often still list it.`);
  } else if (killed.length) {
    verdict = 'DEAD';
    confidence = 'high';
    reasons.push(`A maintainer (${killed[0].login}, ${killed[0].assoc}) stated the bounty will not pay: "${killed[0].quote}"`);
  } else if (paidOut.length) {
    verdict = 'DEAD';
    confidence = 'high';
    reasons.push('A payout announcement is already present; the money is gone even though the issue is open.');
  } else {
    if (evidence.assignee) {
      verdict = 'CONTESTED';
      confidence = 'high';
      reasons.push(`Already assigned to @${evidence.assignee}.`);
    }
    if (competingPrs.length >= 1) {
      verdict = 'CONTESTED';
      confidence = 'high';
      reasons.push(`${competingPrs.length} open PR(s) already reference this issue: ${competingPrs.map((p) => '#' + p.number).join(', ')}.`);
    }
    const crowd = Math.max(attempts, claims);
    if (crowd >= 5 || comments.length >= 40) {
      verdict = verdict === 'LIKELY_PAYABLE' ? 'CROWDED' : verdict;
      reasons.push(`High competition: ${comments.length} comments, ${attempts} /attempt and ${claims} /claim markers.`);
    }
    if (algoraBotPresent && evidence.updated_days_ago > 180) {
      reasons.push(`Algora bounty comment exists but the issue has been quiet for ${evidence.updated_days_ago} days — re-confirm the program is alive before working.`);
      if (verdict === 'LIKELY_PAYABLE') { verdict = 'STALE'; confidence = 'medium'; }
    }
    if (verdict === 'LIKELY_PAYABLE') {
      reasons.push('Open, unassigned, no competing PR found, no maintainer cancellation, no payout announcement.');
      confidence = prSearchFailed ? 'low' : 'medium';
    }
  }

  if (prSearchFailed) reasons.push('PR search failed (rate limit?) — competition may be understated.');

  const scores = { DEAD: 0, NOT_FOUND: 0, CONTESTED: 20, CROWDED: 40, STALE: 50, LIKELY_PAYABLE: 80 };
  return {
    url, repo: slug, number,
    title: issue.title,
    verdict,
    confidence,
    score: scores[verdict] ?? 50,
    reasons,
    evidence,
    checked_at: new Date().toISOString(),
  };
}

module.exports = { checkBounty, parseIssueUrl, KILL_PHRASES, runCli };

// --- CLI ------------------------------------------------------------------
async function runCli(argv) {
  const urls = argv.filter((a) => !a.startsWith('-'));
  const json = argv.includes('--json');
  if (!urls.length) {
    console.error('usage: bounty-sanity-check <github-issue-url> [more urls] [--json]');
    console.error('       bounty-sanity-check --mcp     (run as an MCP stdio server)');
    process.exitCode = 2;
    return;
  }
  const token = process.env.GITHUB_TOKEN || process.env.BOUNTYCHECK_GITHUB_TOKEN || null;
  const out = [];
  for (const u of urls) {
    try {
      out.push(await checkBounty(u, { token }));
    } catch (err) {
      out.push({ url: u, verdict: 'ERROR', reasons: [err.message] });
    }
  }
  if (json) { console.log(JSON.stringify(out, null, 2)); return; }
  for (const r of out) {
    const bar = {
      LIKELY_PAYABLE: '[OK]', STALE: '[STALE]', CROWDED: '[CROWD]',
      CONTESTED: '[CONTEST]', DEAD: '[DEAD]', NOT_FOUND: '[404]', ERROR: '[ERR]',
    }[r.verdict] || '[?]';
    console.log(`${bar} ${r.verdict}  score=${r.score ?? '-'}  ${r.repo || ''}#${r.number || ''}`);
    if (r.title) console.log(`        ${r.title.slice(0, 88)}`);
    if (r.evidence && r.evidence.advertised_bounty_usd) console.log(`        advertised: $${r.evidence.advertised_bounty_usd}`);
    for (const reason of r.reasons || []) console.log(`        - ${reason}`);
    console.log();
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
}
