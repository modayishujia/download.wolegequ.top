const WINDOW = 60;
const LIMIT = 10;
const KEY_PREFIX = 'rl:';

export function rateLimit(env, ip) {
  const kv = env?.RATE_LIMIT_KV;
  if (!kv) return Promise.resolve(null);
  return check(kv, ip);
}

async function check(kv, ip) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / WINDOW) * WINDOW;
  const key = KEY_PREFIX + ip + ':' + windowStart;

  let entry;
  try {
    entry = await kv.get(key, { type: 'json' });
  } catch {
    return null;
  }

  const count = (entry?.c || 0) + 1;
  const resetAt = windowStart + WINDOW;
  const retryAfter = resetAt - now;

  try {
    await kv.put(key, JSON.stringify({ c: count }), { expirationTtl: WINDOW * 2 });
  } catch {}

  if (count > LIMIT) {
    return {
      limited: true,
      remaining: 0,
      resetAt,
      retryAfter,
    };
  }

  return {
    limited: false,
    remaining: LIMIT - count,
    resetAt,
  };
}

export function rateLimitHeaders(result) {
  if (!result) return {};
  return {
    'X-RateLimit-Limit': String(LIMIT),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.resetAt),
  };
}

export function tooManyRequests(result) {
  return new Response(
    JSON.stringify({
      error: 'rate_limited',
      message: `请求过于频繁，每分钟限 ${LIMIT} 次，请 ${result.retryAfter} 秒后重试`,
      retryAfter: result.retryAfter,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(result.retryAfter),
        ...rateLimitHeaders(result),
      },
    }
  );
}
