# bounty-sanity-check

Check whether an open-source bounty will **actually pay you** — before you spend hours on it.

Bounty boards advertise work that cannot pay. The issue is closed. The maintainer
cancelled the whole bounty program months ago. Someone already got paid. Twenty
agents already have open PRs. The board still shows it as open and funded.

This tool reads the evidence that actually predicts payout and gives you a verdict.

## Install

```bash
npx bounty-sanity-check https://github.com/owner/repo/issues/123
```

Set `GITHUB_TOKEN` to avoid rate limits (any token with public repo read is enough).

## Example — a real $50 bounty that cannot pay

```
$ npx bounty-sanity-check https://github.com/coollabsio/coolify/issues/7642

[DEAD] DEAD  score=0  coollabsio/coolify#7642
        [Enhancement]: Add surrealDB with and without TIKV
        advertised: $50
        - A maintainer (Cinzya, MEMBER) stated the bounty will not pay:
          "FYI, we stopped the bounty program with Algora. We asked them to remove
           issues which are still open like this one. Even if you still see a open
           issue on their site, payouts won't work / happen and we don't accept any
           bounty claims."
```

That bounty is still listed as open and funded on the board.

## Verdicts

| Verdict | Score | Meaning |
|---|---|---|
| `LIKELY_PAYABLE` | 80 | Open, unassigned, no competing PR, no cancellation, no payout announced |
| `STALE` | 50 | Bounty comment exists but the issue has been quiet for 6+ months — re-confirm first |
| `CROWDED` | 40 | Heavy competition (many comments / `/attempt` / `/claim` markers) |
| `CONTESTED` | 20 | Already assigned, or open PRs already reference it |
| `DEAD` | 0 | Closed, maintainer cancelled the program, or already paid out |

Every verdict ships with the evidence that produced it — including the verbatim
maintainer quote when a program was cancelled. No black-box scoring.

## What it checks

- **Maintainer cancellation**, counted only from `OWNER` / `MEMBER` / `COLLABORATOR`
  authors — a random commenter saying "this is dead" is not evidence.
- **Payout already announced** in the thread while the issue stays open.
- **Closed but still listed** — the most common stale-board failure.
- **Assignee** set.
- **Competing open PRs** that reference the issue number.
- **Crowd depth**: comment count, `/attempt` and `/claim` markers.
- **Advertised amount** parsed from the Algora bot comment.

## MCP server

Give your coding agent the same check before it starts work:

```json
{
  "mcpServers": {
    "bounty-sanity-check": {
      "command": "npx",
      "args": ["-y", "bounty-sanity-check", "--mcp"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  }
}
```

Exposes one tool, `check_bounty`, taking `url` or `urls`.

## Library

```js
const { checkBounty } = require('bounty-sanity-check');

const r = await checkBounty('https://github.com/owner/repo/issues/123', {
  token: process.env.GITHUB_TOKEN,
});
if (r.score < 50) console.log('skip:', r.reasons.join('; '));
```

## Limits — read these

- It predicts **payability**, not whether your PR will be accepted. A
  `LIKELY_PAYABLE` verdict is not a promise of payment.
- A maintainer can cancel a program **outside** the issue thread (Discord, a blog
  post, the board itself). This only sees GitHub.
- Competition changes by the hour. Re-check immediately before starting work.
- Unauthenticated GitHub requests rate-limit fast; the tool reports when PR search
  failed so you know competition may be understated rather than absent.

## Licence

MIT
