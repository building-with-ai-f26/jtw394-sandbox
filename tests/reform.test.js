// Deterministic tests for app/reform.js. No network, no API key, no cost.
// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { countWords, budgetFor, validateInput, buildMessages, parseReply } = require("../app/reform");

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

test("buildMessages states the word budget, the sections, and fences the resume", () => {
  const [system, user] = buildMessages(good, 150);
  assert.match(system.content, /AT MOST 150 words/);
  assert.match(system.content, /Situation, Task, Action, Result/);
  assert.match(user.content, /<resume>\nLed a team of 4 at Acme\.\n<\/resume>/);
  assert.equal(buildMessages(good, 150, "shorter please").length, 3);
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
