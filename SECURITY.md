# SECURITY.md — Done In 60 Seconds (Build 3 security audit)

- **Live app:** https://done-in-60-seconds.onrender.com/
- **Audit date:** 2026-11-22
- **Lane:** Beginner
- **App type:** **AI app, no database.** There is no sign-in, nothing is saved, and no files are stored. The server calls the Anthropic Claude API with a key that only the server has.

## How the app is protected

| Layer | Protection |
|---|---|
| API key | `ANTHROPIC_API_KEY` exists only in Render's environment variables and the local `.env` file, which git ignores. Only `app/server.js` reads it. It never reaches the browser and is never logged. |
| Per-visitor rate limit | 10 requests per visitor every 15 minutes on `POST /api/reform`, counted before the request body is read. Over the limit, the server returns `429` with a `Retry-After` header. Visitors are identified by `CF-Connecting-IP`, which Cloudflare sets, or else by the last `X-Forwarded-For` entry. |
| Site-wide rate limit | 60 real AI calls per hour across all visitors. A faked header can't get around it. |
| Daily spend cap in the app | `DAILY_BUDGET_USD=1.00`. The server works out each call's cost from token counts and refuses new calls once the day's total reaches the cap. |
| Provider spend cap | **$8/month** limit in the Anthropic Console (Settings → Spend limits). |
| Cost per call | `max_tokens` 2000, effort `low`, a 30-second timeout, and at most one retry. |
| Input limits | Question up to 1,000 characters, resume up to 12,000 characters, request body up to 64 KB. Pace and method are checked on the server. |
| Untrusted resume | The resume goes inside `<resume>` tags and the model is told to treat it as data. The model has no tools, and its reply must follow a JSON schema. |
| Output rendering | Model text is inserted with `textContent` and never with `innerHTML`, which prevents XSS. |
| Browser headers | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. |
| Analytics privacy | No question, resume, or answer text is sent to PostHog. The answer box has `ph-no-capture`, and text inputs are masked in replays. |

## What was checked

### 1. Access controls (AI app with no database: key search plus 30 calls to the AI route)
- **Key search on the live site:** downloaded the live page and searched it for `sk-ant-`, `sk-proj-`, `sk-or-`, `sk_live_`, `sb_secret_` and `service_role`. **No matches.** The only token present is PostHog's `phc_` token, which is meant to be public.
- **Rate-limit test:** sent 30 `POST /api/reform` requests in a row to the live site. The bodies were empty, so the test cost $0 and never reached Claude.
  ```
  400 400 400 400 400 400 400 400 400 400 429 429 429 429 429 429 429 429 429 429 429 429 429 429 429 429 429 429 429 429
  HTTP/1.1 429 Too Many Requests
  retry-after: 893
  {"error":"Too many requests. Try again in 15 minutes."}
  ```
  The first 10 requests passed the rate limit (`400` only means "empty request") and the other 20 were blocked. A screenshot is attached to the submission.

### 2. Secret keys stay on the server
- **Repo search, current files:** no secret keys. The only `sk-ant-` matches are the prefix check in `app/server.js` and help text in error messages and `.env.example`.
- **Repo search, full git history (`git log -p --all`):** no real keys. The only match is the placeholder `sk-or-v1-replace-with-your-key` from Build 1.
- **`.env` and `.spend.json`:** both listed in `.gitignore` and never committed.
- **`GET /.env` on the live site:** returns `404 Not found`.
- **No rotation needed.**

### 3. File storage
Not applicable: the app stores no files.

### 4. Protecting production from the coding agent
- An **"Ask me first" list** is in `AGENTS.md` §4. It covers destructive commands, keys and secrets, anything that costs money, and merges to `main`, which deploy to production.
- This rule was enforced during the audit: when the agent tried to merge PR #6 on its own, Claude Code's permission check blocked it, and the human merged it.
- **Database backup:** not applicable, because there is no database.

### 5. Spending caps and rate limits
- Anthropic Console monthly spend limit: **$8**.
- In-app daily cap: **$1.00**.
- Every route that calls a paid API (only `POST /api/reform`) has a per-visitor limit of 10 per 15 minutes and a site-wide limit of 60 per hour.

### 6. Dependency audit
`npm audit` reported **0 vulnerabilities**. The only dependency is `@anthropic-ai/sdk` 1.8.0.

### 7. Security review by the coding agent
The agent read every file in `app/` and attacked the live site.

## Attack log

| # | Attack | What happened | Status |
|---|---|---|---|
| 1 | **Faked visitor IP.** While rate-limited, sent `X-Forwarded-For: 203.0.113.77` to dodge the per-visitor limit. | **The first attempt got through** (`400` instead of `429`). The limiter trusted the *first* `X-Forwarded-For` entry, which the visitor controls, so an attacker could make unlimited calls and burn the daily budget. | **Fixed in PR #6** and retested on the live site (below). |
| 2 | Faked `CF-Connecting-IP: 203.0.113.99` after the fix | `403`: Cloudflare rejects the request before it reaches the app. | ✅ Blocked |
| 3 | Steal the API key from the page source, the repo, git history, or `/.env` | Nothing found; `/.env` returns `404`. | ✅ Safe |
| 4 | XSS through model output | Output is rendered with `textContent`. The one `innerHTML` in `app/public/index.html` only shows numbers the server calculated. | ✅ Safe |
| 5 | Prompt injection through the resume ("ignore your instructions…") | The resume is inside `<resume>` tags marked as data, the model has no tools, and the reply must fit a JSON schema. The worst case is an odd answer, never a leak or an action. | ✅ Low risk |
| 6 | Oversized body, invalid JSON, out-of-range pace, unknown method | Rejected with `413` or `400` before any call to Claude. | ✅ Safe |
| 7 | Probing hidden routes (`/.env`, `/?x`, other HTTP methods) | All return `404`. | ✅ Safe |

**Retest of attack 1 on the live site after PR #6:**
```
11 normal requests:              400 ×10, then 429
X-Forwarded-For: 203.0.113.77 -> 429
X-Forwarded-For: 203.0.113.78 -> 429
X-Forwarded-For: 198.51.100.5 -> 429
CF-Connecting-IP: 203.0.113.99 -> 403 (rejected by Cloudflare)
both headers faked            -> 403
```

## What was fixed

| PR | Fix |
|---|---|
| #4 | Server reads `HOST` from the environment, so it stays local-only unless Render sets it. |
| #5 | Per-visitor rate limit on the AI route (10 per 15 minutes). |
| #6 | Rate-limit bypass fixed (trusted IP source), site-wide cap of 60 per hour, browser security headers, and AGENTS.md rule 7 based on this mistake. |

## Remaining issues and known limitations

1. **Limits reset when the server restarts.** Rate-limit counts are kept in memory. On Render's free plan, `.spend.json` is wiped whenever the service sleeps (after about 15 minutes idle) or redeploys, so **the $1/day cap is not reliable on Render**. The real backstop is the **$8/month Anthropic limit**.
2. **"Today" for the daily cap is UTC on Render, not New York time.**
3. **Denial of service is possible.** An attacker with many real IP addresses who sends valid requests could use up the 60-per-hour site cap or the daily budget, which blocks real users until the limit resets. The money at risk is still capped.
4. **Parallel requests can slightly overshoot the daily cap.** The budget is checked before each call and updated after, so requests running at the same moment can go a little over the cap, at most a few cents.
5. **The page shows setup details to every visitor.** The cost line shows the day's spend against the cap and the model name, and some error messages mention `.env`. Neither is harmful, but both reveal how the app is set up.
6. **No Content-Security-Policy yet.** It was left out so PostHog's script loading isn't broken. Output is already rendered safely with `textContent`.
7. **The interview question is not tagged as untrusted.** Unlike the resume, it isn't wrapped in tags. The impact is limited to an odd answer for that visitor.
8. **No automated checks on pull requests.** CI isn't required in the Beginner lane, so tests are run by hand with `npm test` (17 tests).
