import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { searchRoute } from './routes/search.js';
import { profileRoute } from './routes/profile.js';
import { onchainRoute } from './routes/onchain.js';
import { pricesRoute } from './routes/prices.js';
import { metaRoute } from './routes/meta.js';

const app = new Hono();

// Middleware
app.use('*', logger());
app.use('*', cors({
  origin: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(','),
  allowMethods: ['GET', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
}));

// Health check
app.get('/', (c) => c.json({ status: 'ok', service: 'tory-api' }));
app.get('/health', (c) => c.json({ status: 'ok' }));

// Routes
app.route('/search', searchRoute);
app.route('/profile', profileRoute);
app.route('/onchain', onchainRoute);
app.route('/prices', pricesRoute);
app.route('/meta', metaRoute);

const port = parseInt(process.env.PORT || '8080');
console.log(`tory-api starting on port ${port}`);
serve({ fetch: app.fetch, port });
