// Small in-memory attempt counter. TFNN runs as one server process, so this is
// enough to stop password guessing without adding a database table or a service.
// Counts reset when the server restarts.
function createLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }

  const live = (key) => {
    const h = hits.get(key);
    if (h && h.resetAt <= Date.now()) { hits.delete(key); return null; }
    return h || null;
  };

  const timer = setInterval(() => { for (const key of hits.keys()) live(key); }, 10 * 60 * 1000);
  timer.unref();

  return {
    // Seconds left to wait if this key is over the limit, otherwise 0
    blockedFor(key) {
      const h = live(key);
      return h && h.count >= max ? Math.ceil((h.resetAt - Date.now()) / 1000) : 0;
    },
    hit(key) {
      const h = live(key) || { count: 0, resetAt: Date.now() + windowMs };
      h.count += 1;
      hits.set(key, h);
    },
    clear(key) { hits.delete(key); },
  };
}

const waitText = (seconds) => {
  const mins = Math.ceil(seconds / 60);
  return mins <= 1 ? 'a minute' : `${mins} minutes`;
};

module.exports = { createLimiter, waitText };
