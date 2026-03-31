import { Hono } from 'hono';
import { cgUrl } from '../lib/coingecko.js';

export const pricesRoute = new Hono();

// Server-side cache
const cache = new Map<string, { prices: number[]; ts: number }>();
const CACHE_TTL = 60 * 60 * 1000;

// Rate limit: track last CoinGecko call time
let lastGeckoCall = 0;
const GECKO_MIN_INTERVAL = 1200;

pricesRoute.get('/', async (c) => {
  const tokenId = c.req.query('id');
  const symbol = c.req.query('symbol') || '';
  const from = c.req.query('from');
  const to = c.req.query('to');

  if (!tokenId || !from || !to) {
    return c.json({ error: 'Missing id, from, to' }, 400);
  }

  const cacheKey = `${tokenId}:${from}:${to}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return c.json({ prices: cached.prices, source: 'cache' });
  }

  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  const now = Date.now();
  if (fromMs > now) return c.json({ prices: [], source: 'future' });

  const clampedToMs = Math.min(toMs, now);
  const daySpan = Math.max(1, Math.round((toMs - fromMs) / 86400000));
  const interval = daySpan <= 7 ? '1h' : '1d';

  // 1. Try Hyperliquid
  try {
    const hlSymbol = symbol.replace(/USDT?$/i, '').toUpperCase();
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'candleSnapshot',
        req: { coin: hlSymbol, interval, startTime: fromMs, endTime: clampedToMs },
      }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    if (Array.isArray(data) && data.length >= 2) {
      const prices = data.map((x: { c: string }) => parseFloat(x.c));
      cache.set(cacheKey, { prices, ts: Date.now() });
      return c.json({ prices, source: 'hyperliquid' });
    }
  } catch { /* fall through */ }

  // 2. CoinGecko with rate limiting
  const waitMs = Math.max(0, GECKO_MIN_INTERVAL - (Date.now() - lastGeckoCall));
  if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));

  try {
    lastGeckoCall = Date.now();
    const fromTs = Math.floor(fromMs / 1000);
    const toTs = Math.floor(clampedToMs / 1000);
    const res = await fetch(
      cgUrl(`https://api.coingecko.com/api/v3/coins/${tokenId}/market_chart/range?vs_currency=usd&from=${fromTs}&to=${toTs}`),
      { signal: AbortSignal.timeout(8000) }
    );
    if (res.ok) {
      const data = await res.json();
      const prices = (data.prices as [number, number][]).map(([, p]) => p);
      if (prices.length >= 2) {
        cache.set(cacheKey, { prices, ts: Date.now() });
        return c.json({ prices, source: 'coingecko' });
      }
    }
  } catch { /* fall through */ }

  // 3. CoinGecko OHLC fallback
  const waitMs2 = Math.max(0, GECKO_MIN_INTERVAL - (Date.now() - lastGeckoCall));
  if (waitMs2 > 0) await new Promise(r => setTimeout(r, waitMs2));

  try {
    lastGeckoCall = Date.now();
    const ohlcDays = Math.max(1, Math.ceil((clampedToMs - fromMs) / 86400000) + 2);
    const res = await fetch(
      cgUrl(`https://api.coingecko.com/api/v3/coins/${tokenId}/ohlc?vs_currency=usd&days=${Math.min(ohlcDays + 30, 90)}`),
      { signal: AbortSignal.timeout(8000) }
    );
    if (res.ok) {
      const ohlc: [number, number, number, number, number][] = await res.json();
      const filtered = ohlc
        .filter(([ts]) => ts >= fromMs && ts <= clampedToMs + 86400000)
        .map(([, , , , close]) => close);
      if (filtered.length >= 2) {
        cache.set(cacheKey, { prices: filtered, ts: Date.now() });
        return c.json({ prices: filtered, source: 'coingecko-ohlc' });
      }
    }
  } catch { /* fall through */ }

  return c.json({ prices: [], source: 'unavailable' });
});
