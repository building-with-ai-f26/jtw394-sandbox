// Deterministic tests for app/reform.js. No network, no API key, no cost.
// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { countWords, budgetFor, validateInput, buildPrompt, replySchema, parseReply, costUsd } = require("../app/reform");

const good = { question: "Tell me about a time you led a team.", resume: "Led a team of 4 at Acme.", wps: 2.5, method: "STAR" };

test("countWords counts whitespace-separated words", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords("  one   two\nthree "), 3);
});

test("budgetFor turns pace into a 60-second word budget", () => {
  assert.equal(budgetFor(2.5), 150);
  assert.equal(budgetFor(0.5), 30);
  assert.equal(budgetFor(2.55), 153);
});

test("validateInput accepts a good request and trims text", () => {
  const r = validateInput({ ...good, question: "  Why us?  " });
  assert.equal(r.ok, true);
  assert.equal(r.value.question, "Why us?");
});

test("validateInput rejects missing, oversized, or out-of-range input", () => {
  assert.equal(validateInput(null).ok, false);
  assert.equal(validateInput({ ...good, question: " " }).ok, false);
  assert.equal(validateInput({ ...good, resume: "" }).ok, false);
  assert.equal(validateInput({ ...good, resume: "x".repeat(12001) }).ok, false);
  assert.equal(validateInput({ ...good, wps: 7 }).ok, false);
  assert.equal(validateInput({ ...good, wps: "fast" }).ok, false);
  assert.equal(validateInput({ ...good, method: "toString" }).ok, false); // not a real method
});

test("buildPrompt states the word budget, the sections, and fences the resume", () => {
  const { system, messages } = buildPrompt(good, 150);
  assert.match(system, /AT MOST 150 words/);
  assert.match(system, /Situation, Task, Action, Result/);
  assert.equal(messages[0].role, "user");
  assert.match(messages[0].content, /<resume>\nLed a team of 4 at Acme\.\n<\/resume>/);
  assert.equal(buildPrompt(good, 150, "shorter please").messages.length, 2);
});

test("replySchema limits section labels to the chosen method", () => {
  const s = replySchema("PSI");
  assert.deepEqual(s.properties.sections.items.properties.label.enum, ["Problem", "Solution", "Impact"]);
  assert.equal(s.additionalProperties, false);
});

test("costUsd prices tokens per model and errs high for unknown models", () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
  assert.equal(costUsd("claude-haiku-5-5", usage), 0.6);
  assert.equal(costUsd("some-future-model", usage), 24); // priced like Opus
  assert.equal(costUsd("claude-haiku-5-5", undefined), 0);
});

test("parseReply orders sections, counts words itself, and fills missing sections", () => {
  const reply = JSON.stringify({
    sections: [
      { label: "result", text: "We shipped on time." },
      { label: "Situation", text: "Our launch was at risk." },
    ],
    gaps: ["Add a metric", 42],
    words: 3, // a model-reported count must be ignored
  });
  const r = parseReply(reply, "STAR");
  assert.equal(r.ok, true);
  assert.deepEqual(r.sections.map(s => s.label), ["Situation", "Task", "Action", "Result"]);
  assert.equal(r.sections[1].text, "");
  assert.equal(r.words, 9);
  assert.deepEqual(r.gaps, ["Add a metric"]);
});

test("parseReply handles code fences and rejects junk", () => {
  const fenced = '```json\n{"sections":[{"label":"Problem","text":"Slow reports."}]}\n```';
  assert.equal(parseReply(fenced, "PSI").ok, true);
  assert.equal(parseReply("not json", "PSI").ok, false);
  assert.equal(parseReply('{"sections":[]}', "PSI").ok, false);
});
