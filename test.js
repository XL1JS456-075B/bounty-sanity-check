#!/usr/bin/env node
/**
 * Offline tests. A synthetic fetch stands in for GitHub so the suite is
 * deterministic and runs with no token and no network.
 */
const assert = require('assert');
const { checkBounty, parseIssueUrl } = require('./index.js');

let pass = 0;
let fail = 0;
function it(name, fn) {
  try { fn(); pass += 1; console.log('  ok  ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
async function ita(name, fn) {
  try { await fn(); pass += 1; console.log('  ok  ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

/** Build a fake fetch returning the given issue/comments/search payloads. */
function fakeGitHub({ issue, comments = [], search = { items: [] }, status = 200 }) {
  return async (url) => {
    const mk = (body, st = 200) => ({
      ok: st >= 200 && st < 300,
      status: st,
      headers: { get: () => null },
      json: async () => body,
    });
    if (status !== 200) return mk({}, status);
    if (url.includes('/comments')) {
      // Honour pagination: page 2+ returns empty so paginate() terminates.
      const page = Number((url.match(/[?&]page=(\d+)/) || [])[1] || 1);
      return mk(page === 1 ? comments : []);
    }
    if (url.includes('/search/issues')) return mk(search);
    return mk(issue);
  };
}

const baseIssue = {
  title: 'Something is broken',
  state: 'open',
  assignee: null,
  labels: [],
  created_at: new Date(Date.now() - 10 * 86400000).toISOString(),
  updated_at: new Date(Date.now() - 1 * 86400000).toISOString(),
};

console.log('parseIssueUrl');
it('parses an issue url', () => {
  assert.deepStrictEqual(parseIssueUrl('https://github.com/a/b/issues/7'), { owner: 'a', repo: 'b', number: 7 });
});
it('rejects a non-issue url', () => {
  assert.throws(() => parseIssueUrl('https://example.com/x'));
});

console.log('\nverdicts');
(async () => {
  await ita('clean open issue -> LIKELY_PAYABLE', async () => {
    const r = await checkBounty('https://github.com/a/b/issues/1', {
      fetchImpl: fakeGitHub({ issue: baseIssue }),
    });
    assert.strictEqual(r.verdict, 'LIKELY_PAYABLE');
    assert.strictEqual(r.score, 80);
  });

  await ita('closed issue -> DEAD', async () => {
    const r = await checkBounty('https://github.com/a/b/issues/1', {
      fetchImpl: fakeGitHub({ issue: { ...baseIssue, state: 'closed', state_reason: 'completed' } }),
    });
    assert.strictEqual(r.verdict, 'DEAD');
  });

  await ita('maintainer cancellation -> DEAD, quote captured', async () => {
    const r = await checkBounty('https://github.com/a/b/issues/1', {
      fetchImpl: fakeGitHub({
        issue: baseIssue,
        comments: [{
          body: 'FYI, we stopped the bounty program with Algora. Payouts won\'t happen.',
          user: { login: 'maint' }, author_association: 'MEMBER', created_at: '2026-09-13T00:00:00Z',
        }],
      }),
    });
    assert.strictEqual(r.verdict, 'DEAD');
    assert.strictEqual(r.evidence.maintainer_cancellation.length, 1);
    assert.match(r.reasons[0], /stopped the bounty program/);
  });

  await ita('SAME claim from a non-maintainer is ignored', async () => {
    const r = await checkBounty('https://github.com/a/b/issues/1', {
      fetchImpl: fakeGitHub({
        issue: baseIssue,
        comments: [{
          body: 'FYI, we stopped the bounty program with Algora. Payouts won\'t happen.',
          user: { login: 'randomguy' }, author_association: 'NONE', created_at: '2026-09-13T00:00:00Z',
        }],
      }),
    });
    assert.strictEqual(r.verdict, 'LIKELY_PAYABLE');
    assert.strictEqual(r.evidence.maintainer_cancellation.length, 0);
  });

  await ita('assignee -> CONTESTED', async () => {
    const r = await checkBounty('https://github.com/a/b/issues/1', {
      fetchImpl: fakeGitHub({ issue: { ...baseIssue, assignee: { login: 'someone' } } }),
    });
    assert.strictEqual(r.verdict, 'CONTESTED');
    assert.strictEqual(r.evidence.assignee, 'someone');
  });

  await ita('competing PR referencing the issue -> CONTESTED', async () => {
    const r = await checkBounty('https://github.com/a/b/issues/42', {
      fetchImpl: fakeGitHub({
        issue: baseIssue,
        search: { items: [{ number: 99, title: 'fix thing', body: 'closes #42', user: { login: 'rival' }, created_at: '2026-10-01T00:00:00Z' }] },
      }),
    });
    assert.strictEqual(r.verdict, 'CONTESTED');
    assert.strictEqual(r.evidence.competing_open_prs.length, 1);
  });

  await ita('a PR mentioning a DIFFERENT number is not counted', async () => {
    const r = await checkBounty('https://github.com/a/b/issues/42', {
      fetchImpl: fakeGitHub({
        issue: baseIssue,
        search: { items: [{ number: 99, title: 'fix', body: 'closes #421', user: { login: 'x' }, created_at: '2026-10-01T00:00:00Z' }] },
      }),
    });
    assert.strictEqual(r.evidence.competing_open_prs.length, 0);
    assert.strictEqual(r.verdict, 'LIKELY_PAYABLE');
  });

  await ita('crowd of /attempt markers -> CROWDED', async () => {
    const comments = Array.from({ length: 6 }, (_, i) => ({
      body: '/attempt #1 my plan', user: { login: 'agent' + i }, author_association: 'NONE', created_at: '2026-10-01T00:00:00Z',
    }));
    const r = await checkBounty('https://github.com/a/b/issues/1', {
      fetchImpl: fakeGitHub({ issue: baseIssue, comments }),
    });
    assert.strictEqual(r.verdict, 'CROWDED');
    assert.strictEqual(r.evidence.attempt_comments, 6);
  });

  await ita('algora amount parsed; long-quiet issue -> STALE', async () => {
    const r = await checkBounty('https://github.com/a/b/issues/1', {
      fetchImpl: fakeGitHub({
        issue: { ...baseIssue, updated_at: new Date(Date.now() - 400 * 86400000).toISOString() },
        comments: [{ body: '## 💎 $50 bounty • algora', user: { login: 'algora-pbc[bot]' }, author_association: 'NONE', created_at: '2024-01-01T00:00:00Z' }],
      }),
    });
    assert.strictEqual(r.evidence.advertised_bounty_usd, 50);
    assert.strictEqual(r.verdict, 'STALE');
  });

  await ita('payout already announced -> DEAD', async () => {
    const r = await checkBounty('https://github.com/a/b/issues/1', {
      fetchImpl: fakeGitHub({
        issue: baseIssue,
        comments: [{ body: 'The bounty has been paid to @winner', user: { login: 'algora-pbc[bot]' }, author_association: 'NONE', created_at: '2026-01-01T00:00:00Z' }],
      }),
    });
    assert.strictEqual(r.verdict, 'DEAD');
  });

  await ita('404 -> NOT_FOUND, no throw', async () => {
    const r = await checkBounty('https://github.com/a/b/issues/1', {
      fetchImpl: fakeGitHub({ issue: {}, status: 404 }),
    });
    assert.strictEqual(r.verdict, 'NOT_FOUND');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
