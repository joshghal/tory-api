import { Hono } from 'hono';
import { getCoinDetail } from '../lib/coingecko.js';

export const metaRoute = new Hono();

metaRoute.get('/', async (c) => {
  const id = c.req.query('id');
  if (!id) return c.json({ error: 'id required' }, 400);

  const coin = await getCoinDetail(id);
  if (!coin) {
    return c.json({ name: id, symbol: id.toUpperCase(), image: '' });
  }

  return c.json({
    name: coin.name,
    symbol: coin.symbol,
    image: coin.image?.large || coin.image?.small || '',
  });
});
