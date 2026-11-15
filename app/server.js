// Local server for "Done In 60 Seconds".
// - Serves the page (app/public/index.html) at http://127.0.0.1:PORT
// - POST /api/reform: checks input, calls OpenRouter with the key from .env, returns the structured answer
// The API key only ever lives here on the server; it is never sent to the browser.
// Run with: npm start   (which is: node --env-file-if-exists=.env app/server.js)

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { validateInput, budgetFor, buildMessages, parseReply } = require("./reform");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "127.0.0.1"; // only reachable from this computer
const API_KEY = process.env.OPENROUTER_API_KEY || "";
const MODEL = process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4.1-flash";
const DAILY_BUDGET_USD = Number(process.env.DAILY_BUDGET_USD) || 1.0;
const MAX_OUTPUT_TOKENS = 900; // caps cost per call; a 60-second answer is ~150-250 words
const MAX_ATTEMPTS = 2; // one retry if the answer is over budget or unreadable
const TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 64 * 1024;
// If OpenRouter doesn't report a cost, assume a deliberately high $2 per million tokens.
const FALLBACK_USD_PER_TOKEN = 2 / 1e6;

const PAGE = path.join(__dirname, "public", "index.html");
const SPEND_FILE = path.join(__dirname, "..", ".spend.json"); // gitignored

const keyLooksUnset = !API_KEY || API_KEY.includes("replace-with-your-key");

// ---- Daily spend guard (persists across restarts in .spend.json) ----
const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local time

function readSpend() {
  try {
    const s = JSON.parse(fs.readFileSync(SPEND_FILE, "utf8"));
    return s.date === today() ? s : { date: today(), usd: 0, runs: 0 };
  } catch {
    return { date: today(), usd: 0, runs: 0 };
  }
}

function addSpend(usd) {
  const s = readSpend();
  s.usd += usd;
  s.runs += 1;
  fs.writeFileSync(SPEND_FILE, JSON.stringify(s));
  return s;
}

// ---- OpenRouter call ----
async function callModel(messages) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "Done In 60 Seconds (local)",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.4,
      response_format: { type: "json_object" },
      usage: { include: true },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    // Log only the status code, never the request (it carries the key) or the user's resume.
    console.error(`OpenRouter error: HTTP ${res.status}`);
    const friendly = {
      401: "OpenRouter rejected the API key. Check OPENROUTER_API_KEY in your .env file.",
      402: "OpenRouter says this key is out of credits or over its spending limit.",
      429: "OpenRouter is rate limiting requests. Wait a moment and try again.",
    }[res.status] || `The AI service returned an error (HTTP ${res.status}). Try again.`;
    const err = new Error(friendly);
    err.status = res.status === 401 || res.status === 402 ? 502 : 503;
    throw err;
  }

  const data = await res.json();
  const usage = data.usage || {};
  const cost = typeof usage.cost === "number"
    ? usage.cost
    : ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)) * FALLBACK_USD_PER_TOKEN;
  return { content: data.choices?.[0]?.message?.content ?? "", cost, usage };
}

// ---- POST /api/reform ----
async function handleReform(body) {
  const checked = validateInput(body);
  if (!checked.ok) return [400, { error: checked.error }];
  if (keyLooksUnset) {
    return [500, { error: "No API key configured. Copy .env.example to .env, add your OpenRouter key, and restart." }];
  }

  const spend = readSpend();
  if (spend.usd >= DAILY_BUDGET_USD) {
    return [429, { error: `Daily AI budget of $${DAILY_BUDGET_USD.toFixed(2)} reached. It resets tomorrow.` }];
  }

  const input = checked.value;
  const budget = budgetFor(input.wps);
  let feedback = null;
  let result = null;
  let totalCost = 0;
  let lastError = "The AI reply could not be read.";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { content, cost } = await callModel(buildMessages(input, budget, feedback));
    totalCost += cost;
    const parsed = parseReply(content, input.method);
    if (!parsed.ok) {
      lastError = parsed.error;
      feedback = "Your last reply could not be parsed. Reply with the JSON object only.";
      continue;
    }
    result = parsed;
    if (parsed.words <= budget) break;
    feedback = `Your last answer was ${parsed.words} words, over the ${budget}-word limit. Rewrite it to at most ${budget} words, same JSON shape.`;
  }

  const after = addSpend(totalCost);
  console.log(`run ok=${!!result} model=${MODEL} cost=$${totalCost.toFixed(5)} today=$${after.usd.toFixed(4)} (${after.runs} runs)`);

  if (!result) return [502, { error: lastError }];
  return [200, {
    sections: result.sections,
    gaps: result.gaps,
    words: result.words,
    budget,
    overBudget: result.words > budget,
    costUsd: totalCost,
    spentTodayUsd: after.usd,
    dailyBudgetUsd: DAILY_BUDGET_USD,
    model: MODEL,
  }];
}

// ---- HTTP plumbing ----
function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error("Request too large."), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("Request body must be JSON."), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      return send(res, 200, fs.readFileSync(PAGE), "text/html; charset=utf-8");
    }
    if (req.method === "POST" && req.url === "/api/reform") {
      const [status, body] = await handleReform(await readJson(req));
      return send(res, status, body);
    }
    send(res, 404, { error: "Not found." });
  } catch (err) {
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    if (!err.status && !timedOut) console.error("Unexpected error:", err.message);
    send(res, err.status || (timedOut ? 504 : 500), {
      error: timedOut ? "The AI took too long to answer. Try again." : (err.status ? err.message : "Something went wrong on the server."),
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Done In 60 Seconds running at http://${HOST}:${PORT}`);
  console.log(`Model: ${MODEL} · Daily budget: $${DAILY_BUDGET_USD.toFixed(2)} · Spent today: $${readSpend().usd.toFixed(4)}`);
  if (keyLooksUnset) console.warn("WARNING: OPENROUTER_API_KEY is not set. Copy .env.example to .env and add your key.");
});
