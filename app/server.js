// Local server for "Done In 60 Seconds".
// - Serves the page (app/public/index.html) at http://127.0.0.1:PORT
// - POST /api/reform: checks input, calls Claude with the key from .env, returns the structured answer
// The API key only ever lives here on the server; it is never sent to the browser.
// Run with: npm start   (which is: node --env-file-if-exists=.env app/server.js)

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const Anthropic = require("@anthropic-ai/sdk").default;
const { validateInput, budgetFor, buildPrompt, replySchema, parseReply, costUsd } = require("./reform");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "127.0.0.1"; // only reachable from this computer
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
const DAILY_BUDGET_USD = Number(process.env.DAILY_BUDGET_USD) || 1.0;
// Caps cost per call. Covers the model's (brief, low-effort) thinking plus a ~150-250 word answer.
const MAX_OUTPUT_TOKENS = 2000;
const MAX_ATTEMPTS = 2; // one retry if the answer is over budget or unreadable
const TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 64 * 1024;

const PAGE = path.join(__dirname, "public", "index.html");
const SPEND_FILE = path.join(__dirname, "..", ".spend.json"); // gitignored

const keyLooksUnset = !API_KEY.startsWith("sk-ant-");
// maxRetries: 1 lets the SDK retry one transient failure (429/5xx/network) on its own.
const client = keyLooksUnset ? null : new Anthropic({ apiKey: API_KEY, timeout: TIMEOUT_MS, maxRetries: 1 });

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

// ---- Claude call ----
// Turns SDK errors into messages a user can act on. Checked most specific first.
function friendlyError(err) {
  // Log only the error type and status, never the request (it carries the key) or the user's resume.
  console.error(`Claude API error: ${err.constructor.name} ${err.status ?? ""}`);
  let message = "The AI service had a problem. Try again in a moment.";
  let status = 503;
  if (err instanceof Anthropic.AuthenticationError) {
    message = "Anthropic rejected the API key. Check ANTHROPIC_API_KEY in your .env file."; status = 502;
  } else if (err instanceof Anthropic.PermissionDeniedError) {
    message = "This API key isn't allowed to use that model. Check the key and ANTHROPIC_MODEL."; status = 502;
  } else if (err instanceof Anthropic.RateLimitError) {
    message = "Anthropic is rate limiting requests. Wait a moment and try again.";
  } else if (err instanceof Anthropic.BadRequestError) {
    // Low credit balance shows up as a 400; point the user at billing either way.
    message = "Anthropic rejected the request. If your credit balance is empty, add credits at console.anthropic.com → Billing."; status = 502;
  } else if (err instanceof Anthropic.APIConnectionTimeoutError) {
    message = "The AI took too long to answer. Try again."; status = 504;
  } else if (err instanceof Anthropic.APIConnectionError) {
    message = "Can't reach Anthropic. Check your internet connection.";
  }
  return Object.assign(new Error(message), { status });
}

async function callModel(input, budget, feedback) {
  const { system, messages } = buildPrompt(input, budget, feedback);
  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages,
      // Low effort keeps thinking (and cost) small; structured output guarantees the JSON shape.
      output_config: { effort: "low", format: { type: "json_schema", schema: replySchema(input.method) } },
    });
  } catch (err) {
    throw friendlyError(err);
  }

  const cost = costUsd(MODEL, response.usage);
  if (response.stop_reason === "refusal") {
    return { content: null, refused: true, cost };
  }
  // A response can start with thinking blocks, so read the answer from text blocks by type.
  const content = response.content.filter(b => b.type === "text").map(b => b.text).join("");
  return { content, refused: false, cost };
}

// ---- POST /api/reform ----
async function handleReform(body) {
  const checked = validateInput(body);
  if (!checked.ok) return [400, { error: checked.error }];
  if (keyLooksUnset) {
    return [500, { error: "No API key configured. Add your Anthropic key (starts with sk-ant-) to .env and restart." }];
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
    const { content, refused, cost } = await callModel(input, budget, feedback);
    totalCost += cost;
    if (refused) {
      lastError = "Claude declined to answer this one. Try rewording the question or removing unusual text from the resume.";
      break; // a retry with the same input would likely be declined again
    }
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
  if (keyLooksUnset) console.warn("WARNING: ANTHROPIC_API_KEY is not set in .env (it should start with sk-ant-).");
});
