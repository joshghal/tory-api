import { Hono } from 'hono';
import { searchTokens } from '../lib/coingecko.js';

export const searchRoute = new Hono();

searchRoute.get('/', async (c) => {
  const query = c.req.query('query');
  if (!query) return c.json({ error: 'Query parameter is required' }, 400);

  try {
    const cgResults = await searchTokens(query);

    const transformed = cgResults.slice(0, 20).map((coin) => ({
      label: coin.name,
      symbol: coin.symbol.toUpperCase(),
      image: coin.large || coin.thumb || '',
      arkhamSlug: coin.id,
    }));

    return c.json({ message: 'SUCCESS', status: 200, data: transformed });
  } catch (error) {
    console.error('[Search]', error);
    return c.json({ message: 'Failed', status: 200, data: [] });
  }
});
