// Deterministic tests for app/ratelimit.js. Uses a fake clock, so no waiting. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRateLimiter, clientIp } = require("../app/ratelimit");

function setup() {
  let t = 0;
  const limiter = createRateLimiter({ limit: 10, windowMs: 15 * 60 * 1000, now: () => t });
  return { limiter, advance: ms => { t += ms; } };
}

test("allows 10 requests, then blocks the 11th with a Retry-After", () => {
  const { limiter } = setup();
  for (let i = 1; i <= 10; i++) assert.equal(limiter.check("1.1.1.1").ok, true, `request ${i}`);
  const blocked = limiter.check("1.1.1.1");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfterSec, 15 * 60);
});

test("30 calls in a row: first 10 pass, last 20 are blocked", () => {
  const { limiter } = setup();
  const results = Array.from({ length: 30 }, () => limiter.check("1.1.1.1").ok);
  assert.equal(results.filter(Boolean).length, 10);
  assert.deepEqual(results.slice(10), Array(20).fill(false));
});

test("the window resets after 15 minutes", () => {
  const { limiter, advance } = setup();
  for (let i = 0; i < 11; i++) limiter.check("1.1.1.1");
  advance(14 * 60 * 1000);
  assert.equal(limiter.check("1.1.1.1").ok, false);
  advance(60 * 1000);
  assert.equal(limiter.check("1.1.1.1").ok, true);
});

test("different visitors have separate limits", () => {
  const { limiter } = setup();
  for (let i = 0; i < 11; i++) limiter.check("1.1.1.1");
  assert.equal(limiter.check("1.1.1.1").ok, false);
  assert.equal(limiter.check("2.2.2.2").ok, true);
});

test("clientIp uses the first X-Forwarded-For entry, else the socket address", () => {
  assert.equal(clientIp({ headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" }, socket: {} }), "9.9.9.9");
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }), "127.0.0.1");
});
