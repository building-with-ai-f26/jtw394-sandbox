# AGENTS.md — Coding Agent Operating Manual

> Give this file to your coding agent and check that it is using these instructions. Keep the stack, commands, and ground rules current.

## 1. Project Overview
- **What this repo builds:** *Done In 60 Seconds*: the user enters an interview question, pastes their resume, sets a speaking pace, and picks STAR or Problem·Solution·Impact. An AI model writes an answer drawn from the resume that can be said aloud in 60 seconds.
- **Primary user & core workflow:** See the living PRD in `docs/index.html`.
- **Tech stack:** Node.js 22+ (built-in `http`) / plain HTML+JS page / Anthropic Claude API via the official `@anthropic-ai/sdk` (the only dependency; default model `claude-haiku-5-5`).

### Project structure
| Path | What it is |
| --- | --- |
| `app/server.js` | Node server (`127.0.0.1` locally, `0.0.0.0` on Render). Serves the page, handles `POST /api/reform`, calls Claude with the key from `.env`, and enforces the daily spend cap. |
| `app/ratelimit.js` | Rate limits for `/api/reform`: 10 requests / 15 min per visitor IP (from `CF-Connecting-IP`, else the last `X-Forwarded-For` entry, never the first) plus 60 AI calls / hour site-wide. In memory. Returns `429`. |
| `app/reform.js` | Pure logic: input checks, word budget (pace × 60), prompt + JSON schema, reply parsing, and cost from token counts (per-model price table). No network. |
| `app/public/index.html` | The UI. Talks only to `/api/reform` and never sees the API key. |
| `tests/reform.test.js`, `tests/ratelimit.test.js` | Deterministic `node:test` tests for `app/reform.js` and `app/ratelimit.js`. |
| `docs/` | Public GitHub Pages Product Page and the Build 1 browser-only prototypes. **Never put the app or keys here.** |
| `.env` (gitignored) | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `DAILY_BUDGET_USD`, `PORT`, `HOST`, `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST`. See `.env.example`. |
| `.spend.json` (gitignored) | Today's AI spend and run count, written by the server. |

### Data flow (one user action)
Browser → `POST /api/reform` with `{question, resume, wps, method}` → server checks the input and the daily budget → Claude Messages API (structured JSON output, effort `low`, `max_tokens` 2000, 30 s timeout) → server parses the reply and **counts the words itself**. If the answer is over budget or unreadable, the server retries once → the browser gets the sections, gaps, word count, and cost.

### Analytics (PostHog)
- Local app: `app/server.js` injects `POSTHOG_PROJECT_TOKEN`/`POSTHOG_HOST` from `.env` into the page (`<!-- POSTHOG_CONFIG -->` marker); with no token, analytics is off. Product Page: the snippet with the public `phc_` token is in `docs/index.html` (static hosting has no env).
- Events: autocaptured pageviews and clicks, plus `answer_requested`, `answer_generated`, `answer_failed`, `answer_copied` from `app/public/index.html`.
- Privacy: never send question, resume, or answer text in event properties. The answer box has `ph-no-capture` so it is hidden in session replays; text inputs are masked by default.

### AI & key rules for this project
- The API key is read only in `app/server.js` from `process.env`. Never send it to the browser, log it, or put it in `docs/`.
- The server binds to `127.0.0.1` by default. Only the host (Render) sets `HOST=0.0.0.0`; never set it in a local `.env` or hard-code it. Keep the input size limits, `max_tokens`, the per-visitor rate limit, and `DAILY_BUDGET_USD` guard in place. Any new route that calls a paid API must go through the rate limiter.
- The resume is untrusted user data: keep it inside `<resume>` tags, and render model output with `textContent`, never `innerHTML`.
- Also set a monthly spend limit in the Anthropic Console (Settings → Spend limits; it is monthly, currently $8). The in-app cap only covers this app. If you change `ANTHROPIC_MODEL`, update `PRICES` in `app/reform.js` too.

## 2. Commands
- **Install dependencies:** `npm install` (`node -v` must be 22+). First run: `cp .env.example .env`, then add your Anthropic key.
- **Run locally:** `npm start` → open http://127.0.0.1:3000
- **Run deterministic tests:** `npm test`
- **Run model evals:** not yet (Build 4)

## 3. Shipping (Render)
The live app is a Render **Web Service** (free plan) that deploys automatically from `main`.
- **Settings:** Language Node · Build `npm install` · Start `npm start` · Branch `main`.
- **Environment variables (set in the Render dashboard, never in the repo):** `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `DAILY_BUDGET_USD`, `HOST=0.0.0.0`, `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST`. Do not set `PORT`; Render provides it.
- **Steps the agent follows:**
  1. Work on a branch, run `npm test`, and check the app locally with `npm start`.
  2. Open a pull request. The human reviews and merges it into `main`.
  3. Render redeploys on its own. Watch the Render logs for `Done In 60 Seconds running at`.
  4. Verify the live URL: the page loads and one answer generates (on a phone too).
- **Known limits:** the free instance sleeps after ~15 min idle (first load takes 30-60 s), and its disk is wiped on restart/redeploy, so `.spend.json` (the daily cap) resets then. The Anthropic Console monthly limit is the real backstop.

## 4. Non-Negotiable Engineering Rules
1. **Plan before coding:** Before touching multiple files, propose a brief plan and wait for approval.
2. **Small batches:** Make small, focused changes that can be reviewed and explained by a human in a single Pull Request.
3. **Explainability:** Avoid unnecessary abstractions or dependencies. Help the human builder understand the main components, what changed, why it matters, what could break, and how it was checked.
4. **Verify changes:** Run relevant checks. For a reproducible logic bug, use a failing test to demonstrate the fix when practical. Record manual checks and known limitations; follow the selected Build 4 evaluation track.
5. **Zero secrets in code:** Never hardcode API keys, tokens, or credentials. Always read from environment variables (`.env`) and update `.env.example` when new variables are needed.
6. **Stop when looping:** If a fix fails twice in a row, stop, summarize what failed, and ask the human before trying a third approach.
7. **Never trust what the visitor can write (learned the hard way):** In Build 3 the agent's first rate limit identified visitors by the *first* `X-Forwarded-For` entry, which the visitor controls; the security review bypassed it with a fake header. Any security decision (who the visitor is, what they may do) must use values the proxy or server sets, and every such fix must be re-tested on the live site with a spoofed request.
