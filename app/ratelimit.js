// Per-visitor rate limit for POST /api/reform. In memory, no dependencies.
// Each visitor (by IP) gets `limit` requests per `windowMs`; after that, check() says no until the
// window that started with their first request has passed. Counts reset when the server restarts.

function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const visitors = new Map(); // ip -> { start, count }

  function check(ip) {
    const t = now();
    // Keep memory bounded: drop expired entries once the map gets large.
    if (visitors.size > 10000) {
      for (const [key, v] of visitors) if (t - v.start >= windowMs) visitors.delete(key);
    }
    let v = visitors.get(ip);
    if (!v || t - v.start >= windowMs) {
      v = { start: t, count: 0 };
      visitors.set(ip, v);
    }
    v.count += 1;
    if (v.count <= limit) return { ok: true, remaining: limit - v.count };
    return { ok: false, retryAfterSec: Math.ceil((v.start + windowMs - t) / 1000) };
  }

  return { check };
}

// Who is the visitor? Never trust the FIRST X-Forwarded-For entry: the visitor can write anything there
// (security review, attack 1). Render sits behind Cloudflare, which sets CF-Connecting-IP to the real
// address itself. Without it, use the LAST X-Forwarded-For entry (added by the proxy, not the visitor).
// Locally there is no proxy, so use the connection's address.
function clientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",").pop().trim();
  return req.socket.remoteAddress || "unknown";
}

module.exports = { createRateLimiter, clientIp };
