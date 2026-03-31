const CG_KEY = process.env.CG_DEMO_API_KEY || '';
const cgParam = CG_KEY ? `&x_cg_demo_api_key=${CG_KEY}` : '';
export function cgUrl(url: string) { return url + (url.includes('?') ? cgParam : '?' + cgParam.slice(1)); }

interface CoinGeckoListItem {
  id: string;
  symbol: string;
  name: string;
}

interface CoinGeckoMarketItem {
  id: string;
  symbol: string;
  name: string;
  image: string;
  current_price: number;
  market_cap: number;
  total_volume: number;
  high_24h: number;
  low_24h: number;
  price_change_24h: number;
  price_change_percentage_24h: number;
  circulating_supply: number;
  total_supply: number | null;
  max_supply: number | null;
  ath: number;
  atl: number;
}

interface CoinGeckoPricePoint {
  time: string;
  usd: number;
  volume24h: number;
  marketCap: number;
}

interface CoinGeckoSearchResult {
  id: string;
  name: string;
  api_symbol: string;
  symbol: string;
  market_cap_rank: number | null;
  thumb: string;
  large: string;
}

let cachedCoinList: CoinGeckoListItem[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000;

export async function getCoinList(): Promise<CoinGeckoListItem[]> {
  if (cachedCoinList && Date.now() - cacheTimestamp < CACHE_TTL) {
    return cachedCoinList;
  }

  const res = await fetch(cgUrl('https://api.coingecko.com/api/v3/coins/list'), {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) throw new Error(`CoinGecko list error: ${res.status}`);

  cachedCoinList = await res.json();
  cacheTimestamp = Date.now();
  return cachedCoinList!;
}

/**
 * Search tokens via CoinGecko
 */
export async function searchTokens(query: string): Promise<CoinGeckoSearchResult[]> {
  const res = await fetch(
    cgUrl(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`),
    { headers: { Accept: 'application/json' } }
  );

  if (!res.ok) return [];
  const json = await res.json();
  return json.coins || [];
}

/**
 * Get market stats for one or more tokens
 */
export async function getMarketStats(ids: string[]): Promise<CoinGeckoMarketItem[]> {
  const res = await fetch(
    cgUrl(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids.join(',')}&order=market_cap_desc&per_page=250&page=1`),
    { headers: { Accept: 'application/json' } }
  );

  if (!res.ok) return [];
  return res.json();
}

/**
 * Get price history for a token (daily data points)
 * Returns format compatible with existing TokenPriceHistory interface
 */
export async function getPriceHistory(
  id: string,
  days: number = 365
): Promise<CoinGeckoPricePoint[]> {
  const res = await fetch(
    cgUrl(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}&precision=2`),
    { headers: { Accept: 'application/json' } }
  );

  if (!res.ok) return [];
  const json = await res.json();

  // Transform CoinGecko format to our TokenPriceHistory format
  const prices: [number, number][] = json.prices || [];
  const volumes: [number, number][] = json.total_volumes || [];
  const marketCaps: [number, number][] = json.market_caps || [];

  const volumeMap = new Map(volumes.map(([t, v]) => [t, v]));
  const mcMap = new Map(marketCaps.map(([t, mc]) => [t, mc]));

  return prices.map(([timestamp, price]) => ({
    time: new Date(timestamp).toISOString(),
    usd: price,
    volume24h: volumeMap.get(timestamp) || 0,
    marketCap: mcMap.get(timestamp) || 0,
  }));
}

/**
 * Cached coin detail — fetched once, reused across profile + onchain + metadata.
 * Eliminates duplicate CoinGecko calls for the same token.
 */
export interface CoinDetail {
  id: string;
  name: string;
  symbol: string;
  image: { large?: string; small?: string; thumb?: string };
  platforms: Record<string, string>;
  detail_platforms: Record<string, { decimal_place: number }>;
  market_data?: {
    circulating_supply?: number;
    total_supply?: number;
    current_price?: { usd?: number };
  };
}

const coinDetailCache = new Map<string, { data: CoinDetail; ts: number }>();
const COIN_DETAIL_TTL = 60 * 60 * 1000; // 1 hour

export async function getCoinDetail(id: string): Promise<CoinDetail | null> {
  const cached = coinDetailCache.get(id);
  if (cached && Date.now() - cached.ts < COIN_DETAIL_TTL) return cached.data;

  try {
    const res = await fetch(
      cgUrl(`https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`),
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const detail: CoinDetail = {
      id: data.id,
      name: data.name,
      symbol: (data.symbol || '').toUpperCase(),
      image: data.image || {},
      platforms: data.platforms || {},
      detail_platforms: data.detail_platforms || {},
      market_data: data.market_data ? {
        circulating_supply: data.market_data.circulating_supply,
        total_supply: data.market_data.total_supply,
        current_price: data.market_data.current_price,
      } : undefined,
    };
    coinDetailCache.set(id, { data: detail, ts: Date.now() });
    return detail;
  } catch {
    return null;
  }
}

/**
 * Convert CoinGecko market data to our TokenStats format
 */
export function toTokenStats(market: CoinGeckoMarketItem): {
  price: number;
  totalVolume: number;
  price24hAgo: number;
  maxPrice24h: number;
  minPrice24h: number;
  circulatingSupply: number;
  totalSupply: number;
  allTimeHigh: number;
  allTimeLow: number;
  marketCap: number;
} {
  return {
    price: market.current_price,
    totalVolume: market.total_volume,
    price24hAgo: market.current_price - (market.price_change_24h || 0),
    maxPrice24h: market.high_24h,
    minPrice24h: market.low_24h,
    circulatingSupply: market.circulating_supply,
    totalSupply: market.total_supply || 0,
    allTimeHigh: market.ath,
    allTimeLow: market.atl,
    marketCap: market.market_cap,
  };
}

/**
 * Match a CryptoRank slug from their search results
 */
export function matchCryptoRankSlug(
  tokenName: string,
  tokenSymbol: string,
  coingeckoId: string,
  cryptoRankCoins: { key: string; name: string; symbol: string }[]
): string | undefined {
  const nameLC = tokenName.toLowerCase();
  const symbolLC = tokenSymbol.toLowerCase();
  const idLC = coingeckoId.toLowerCase();

  const byName = cryptoRankCoins.find(c => c.name?.toLowerCase() === nameLC);
  if (byName) return byName.key;

  const bySymbol = cryptoRankCoins.find(c => c.symbol?.toLowerCase() === symbolLC);
  if (bySymbol) return bySymbol.key;

  const byKey = cryptoRankCoins.find(c => c.key?.toLowerCase() === idLC);
  if (byKey) return byKey.key;

  return undefined;
}
