# AGENTS.md — Coding Agent Operating Manual

> Give this file to your coding agent and check that it is using these instructions. Keep the stack, commands, and ground rules current.

## 1. Project Overview
- **What this repo builds:** *Done In 60 Seconds*: the user enters an interview question, pastes their resume, sets a speaking pace, and picks STAR or Problem·Solution·Impact. An AI model writes an answer drawn from the resume that can be said aloud in 60 seconds.
- **Primary user & core workflow:** See the living PRD in `docs/index.html`.
- **Tech stack:** Node.js 22+ (built-in `http`) / plain HTML+JS page / Anthropic Claude API via the official `@anthropic-ai/sdk` (the only dependency; default model `claude-haiku-5-5`).

### Project structure
| Path | What it is |
| --- | --- |
| `app/server.js` | Local server on `127.0.0.1`. Serves the page, handles `POST /api/reform`, calls Claude with the key from `.env`, and enforces the daily spend cap. |
| `app/reform.js` | Pure logic: input checks, word budget (pace × 60), prompt + JSON schema, reply parsing, and cost from token counts (per-model price table). No network. |
| `app/public/index.html` | The UI. Talks only to `/api/reform` and never sees the API key. |
| `tests/reform.test.js` | Deterministic `node:test` tests for `app/reform.js`. |
| `docs/` | Public GitHub Pages Product Page and the Build 1 browser-only prototypes. **Never put the app or keys here.** |
| `.env` (gitignored) | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `DAILY_BUDGET_USD`, `PORT`, `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST`. See `.env.example`. |
| `.spend.json` (gitignored) | Today's AI spend and run count, written by the server. |

### Data flow (one user action)
Browser → `POST /api/reform` with `{question, resume, wps, method}` → server checks the input and the daily budget → Claude Messages API (structured JSON output, effort `low`, `max_tokens` 2000, 30 s timeout) → server parses the reply and **counts the words itself**. If the answer is over budget or unreadable, the server retries once → the browser gets the sections, gaps, word count, and cost.

### Analytics (PostHog)
- Local app: `app/server.js` injects `POSTHOG_PROJECT_TOKEN`/`POSTHOG_HOST` from `.env` into the page (`<!-- POSTHOG_CONFIG -->` marker); with no token, analytics is off. Product Page: the snippet with the public `phc_` token is in `docs/index.html` (static hosting has no env).
- Events: autocaptured pageviews and clicks, plus `answer_requested`, `answer_generated`, `answer_failed`, `answer_copied` from `app/public/index.html`.
- Privacy: never send question, resume, or answer text in event properties. The answer box has `ph-no-capture` so it is hidden in session replays; text inputs are masked by default.

### AI & key rules for this project
- The API key is read only in `app/server.js` from `process.env`. Never send it to the browser, log it, or put it in `docs/`.
- The server binds to `127.0.0.1` only. Keep the input size limits, `max_tokens`, and `DAILY_BUDGET_USD` guard in place.
- The resume is untrusted user data: keep it inside `<resume>` tags, and render model output with `textContent`, never `innerHTML`.
- Also set a monthly spend limit in the Anthropic Console (Settings → Limits). The in-app cap only covers this app. If you change `ANTHROPIC_MODEL`, update `PRICES` in `app/reform.js` too.

## 2. Commands
- **Install dependencies:** `npm install` (`node -v` must be 22+). First run: `cp .env.example .env`, then add your Anthropic key.
- **Run locally:** `npm start` → open http://127.0.0.1:3000
- **Run deterministic tests:** `npm test`
- **Run model evals:** not yet (Build 4)

## 3. Non-Negotiable Engineering Rules
1. **Plan before coding:** Before touching multiple files, propose a brief plan and wait for approval.
2. **Small batches:** Make small, focused changes that can be reviewed and explained by a human in a single Pull Request.
3. **Explainability:** Avoid unnecessary abstractions or dependencies. Help the human builder understand the main components, what changed, why it matters, what could break, and how it was checked.
4. **Verify changes:** Run relevant checks. For a reproducible logic bug, use a failing test to demonstrate the fix when practical. Record manual checks and known limitations; follow the selected Build 4 evaluation track.
5. **Zero secrets in code:** Never hardcode API keys, tokens, or credentials. Always read from environment variables (`.env`) and update `.env.example` when new variables are needed.
6. **Stop when looping:** If a fix fails twice in a row, stop, summarize what failed, and ask the human before trying a third approach.
