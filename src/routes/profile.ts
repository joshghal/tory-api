import { Hono } from 'hono';
import { getPriceHistory, getCoinDetail } from '../lib/coingecko.js';
import { buildTokenProfile } from '../lib/tokenProfiler.js';
import { onchainCache } from '../lib/onchainCache.js';

export const profileRoute = new Hono();

// Profile-level cache
const profileCache = new Map<string, { response: any; ts: number; hasOnchain: boolean }>();
const PROFILE_TTL = 30 * 60 * 1000;

profileRoute.get('/', async (c) => {
  const id = c.req.query('id');
  const symbol = c.req.query('symbol') || id?.toUpperCase() || '';

  if (!id) return c.json({ error: 'id parameter required' }, 400);

  // Check cache
  const cached = profileCache.get(id);
  const onchainNowAvailable = !!onchainCache.get(id);
  if (cached && Date.now() - cached.ts < PROFILE_TTL) {
    if (!cached.hasOnchain && onchainNowAvailable) {
      // Fall through to re-compute with on-chain data
    } else {
      return c.json(cached.response);
    }
  }

  try {
    const from = new Date(Date.now() - 90 * 86400000).toISOString();
    const to = new Date().toISOString();
    const fromMs = Date.now() - 90 * 86400000;

    // --- Helper: Santiment GraphQL ---
    const santimentQuery = async (metric: string): Promise<{ datetime: string; value: number }[]> => {
      try {
        const res = await fetch('https://api.santiment.net/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `{ getMetric(metric: "${metric}") { timeseriesData(slug: "${id}", from: "${from}", to: "${to}", interval: "1d") { datetime value } } }`,
          }),
        });
        if (!res.ok) return [];
        const json = await res.json();
        return json?.data?.getMetric?.timeseriesData || [];
      } catch { return []; }
    };

    // --- Helper: Binance Futures ---
    const binanceFutures = async (endpoint: string, params: string): Promise<any[]> => {
      try {
        const res = await fetch(`https://fapi.binance.com${endpoint}?${params}`, {
          headers: { 'Accept': 'application/json' },
        });
        if (!res.ok) return [];
        return await res.json();
      } catch { return []; }
    };

    // --- Helper: Hyperliquid ---
    const hyperliquidData = async (): Promise<{
      funding: { date: string; value: number }[] | undefined;
      hlVolume: { date: string; value: number }[] | undefined;
      hlDailyRange: { date: string; value: number }[] | undefined;
      hlCandleBody: { date: string; value: number }[] | undefined;
      hlUpperWick: { date: string; value: number }[] | undefined;
      hlLowerWick: { date: string; value: number }[] | undefined;
      hlCandles: { date: string; close: number; volume: number; high: number; low: number }[] | undefined;
    }> => {
      try {
        const hlSymbol = symbol.toUpperCase();
        const fundingRes = await fetch('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'fundingHistory', coin: hlSymbol, startTime: fromMs }),
        });

        let fundingDaily: { date: string; value: number }[] | undefined;
        if (fundingRes.ok) {
          const fundingRaw: any[] = await fundingRes.json();
          if (fundingRaw.length > 0) {
            const byDate: Record<string, { sum: number; count: number }> = {};
            for (const f of fundingRaw) {
              const date = new Date(f.time).toISOString().split('T')[0];
              if (!byDate[date]) byDate[date] = { sum: 0, count: 0 };
              byDate[date].sum += parseFloat(f.fundingRate);
              byDate[date].count++;
            }
            fundingDaily = Object.entries(byDate).map(([date, { sum, count }]) => ({ date, value: sum / count }));
          }
        }

        const candleRes = await fetch('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'candleSnapshot', req: { coin: hlSymbol, interval: '1d', startTime: fromMs, endTime: Date.now() } }),
        });

        let hlVolume: { date: string; value: number }[] | undefined;
        let hlDailyRange: { date: string; value: number }[] | undefined;
        let hlCandleBody: { date: string; value: number }[] | undefined;
        let hlUpperWick: { date: string; value: number }[] | undefined;
        let hlLowerWick: { date: string; value: number }[] | undefined;
        let hlCandles: { date: string; close: number; volume: number; high: number; low: number }[] | undefined;

        if (candleRes.ok) {
          const candles: any[] = await candleRes.json();
          if (candles.length > 0) {
            hlVolume = []; hlDailyRange = []; hlCandleBody = []; hlUpperWick = []; hlLowerWick = []; hlCandles = [];
            for (const cc of candles) {
              const date = new Date(cc.t).toISOString().split('T')[0];
              const o = parseFloat(cc.o), h = parseFloat(cc.h), l = parseFloat(cc.l), close = parseFloat(cc.c), v = parseFloat(cc.v);
              if (close <= 0) continue;
              hlVolume.push({ date, value: v });
              hlDailyRange.push({ date, value: (h - l) / close });
              hlCandleBody.push({ date, value: (close - o) / o });
              hlUpperWick.push({ date, value: (h - Math.max(o, close)) / close });
              hlLowerWick.push({ date, value: (Math.min(o, close) - l) / close });
              hlCandles.push({ date, close, volume: v, high: h, low: l });
            }
          }
        }

        return { funding: fundingDaily, hlVolume, hlDailyRange, hlCandleBody, hlUpperWick, hlLowerWick, hlCandles };
      } catch {
        return { funding: undefined, hlVolume: undefined, hlDailyRange: undefined, hlCandleBody: undefined, hlUpperWick: undefined, hlLowerWick: undefined, hlCandles: undefined };
      }
    };

    // --- Helper: DeFiLlama ---
    const defiLlamaTVL = async (): Promise<{ date: string; value: number }[]> => {
      try {
        const res = await fetch(`https://api.llama.fi/protocol/${id}`);
        if (!res.ok) return [];
        const json = await res.json();
        return (json?.tvl || [])
          .filter((d: any) => d.date * 1000 >= fromMs)
          .map((d: any) => ({ date: new Date(d.date * 1000).toISOString().split('T')[0], value: d.totalLiquidityUSD }));
      } catch { return []; }
    };

    const binanceSymbol = `${symbol.toUpperCase()}USDT`;
    const onchainCached = onchainCache.get(id);
    const onchainMetrics = onchainCached ? onchainCached.data.metrics : null;

    // === FETCH ALL DATA IN PARALLEL ===
    const [
      priceHistory, fgRes,
      sentPos, sentNeg, socialVol, devAct,
      mvrv, exchangeBalance, activeAddresses, networkGrowth,
      whaleTransactions, nvt, socialDominance, devContributors,
      binanceFunding, binanceOI, binanceLongShort, binanceTakerRatio,
      tvlData, hlData,
    ] = await Promise.all([
      getPriceHistory(id, 90),
      fetch('https://api.alternative.me/fng/?limit=90&format=json'),
      santimentQuery('sentiment_positive_total'),
      santimentQuery('sentiment_negative_total'),
      santimentQuery('social_volume_total'),
      santimentQuery('dev_activity'),
      santimentQuery('mvrv_usd'),
      santimentQuery('exchange_balance'),
      santimentQuery('daily_active_addresses'),
      santimentQuery('network_growth'),
      santimentQuery('whale_transaction_count_100k_usd_to_inf'),
      santimentQuery('nvt'),
      santimentQuery('social_dominance_total'),
      santimentQuery('dev_activity_contributors_count'),
      binanceFutures('/fapi/v1/fundingRate', `symbol=${binanceSymbol}&limit=270`),
      binanceFutures('/futures/data/openInterestHist', `symbol=${binanceSymbol}&period=1d&limit=90`),
      binanceFutures('/futures/data/topLongShortAccountRatio', `symbol=${binanceSymbol}&period=1d&limit=90`),
      binanceFutures('/futures/data/takerlongshortRatio', `symbol=${binanceSymbol}&period=1d&limit=90`),
      defiLlamaTVL(),
      hyperliquidData(),
    ]);

    // === TRANSFORMS ===
    const fgData = fgRes.ok ? await fgRes.json() : { data: [] };
    const fearGreedData = (fgData.data || []).map((d: any) => ({
      date: new Date(parseInt(d.timestamp) * 1000).toISOString().split('T')[0],
      value: parseInt(d.value),
    }));

    let priceData: { date: string; price: number; volume: number; marketCap: number }[];
    let cgDailyOhlc: { date: string; high: number; low: number }[] = [];

    if (priceHistory.length > 0) {
      priceData = priceHistory.map((p) => ({ date: p.time.split('T')[0], price: p.usd, volume: p.volume24h, marketCap: p.marketCap }));
      const dailyHL: Record<string, { high: number; low: number }> = {};
      for (const p of priceHistory) {
        const date = p.time.split('T')[0];
        if (!dailyHL[date]) { dailyHL[date] = { high: p.usd, low: p.usd }; }
        else { if (p.usd > dailyHL[date].high) dailyHL[date].high = p.usd; if (p.usd < dailyHL[date].low) dailyHL[date].low = p.usd; }
      }
      cgDailyOhlc = Object.entries(dailyHL).map(([date, { high, low }]) => ({ date, high, low }));
    } else {
      priceData = (hlData.hlCandles || []).map((cc) => ({ date: cc.date, price: cc.close, volume: cc.volume, marketCap: 0 }));
    }

    const toDateValue = (data: { datetime: string; value: number }[]) =>
      data.length > 0 ? data.map((d) => ({ date: d.datetime.split('T')[0], value: d.value })) : undefined;

    const sentimentData = sentPos.length > 0 && sentNeg.length > 0
      ? sentPos.map((s, i) => ({ date: s.datetime.split('T')[0], positive: s.value, negative: sentNeg[i]?.value || 0 }))
      : undefined;

    const binanceFundingDaily = (() => {
      if (!Array.isArray(binanceFunding) || binanceFunding.length === 0) return undefined;
      const byDate: Record<string, { sum: number; count: number }> = {};
      for (const f of binanceFunding) { const date = new Date(f.fundingTime).toISOString().split('T')[0]; if (!byDate[date]) byDate[date] = { sum: 0, count: 0 }; byDate[date].sum += parseFloat(f.fundingRate); byDate[date].count++; }
      return Object.entries(byDate).map(([date, { sum, count }]) => ({ date, value: sum / count }));
    })();

    const binanceOIDaily = (() => {
      if (!Array.isArray(binanceOI) || binanceOI.length === 0) return undefined;
      return binanceOI.map((d: any) => ({ date: new Date(d.timestamp).toISOString().split('T')[0], value: parseFloat(d.sumOpenInterestValue) }));
    })();

    const binanceLSDaily = (() => {
      if (!Array.isArray(binanceLongShort) || binanceLongShort.length === 0) return undefined;
      return binanceLongShort.map((d: any) => ({ date: new Date(d.timestamp).toISOString().split('T')[0], value: parseFloat(d.longShortRatio) }));
    })();

    const binanceTakerDaily = (() => {
      if (!Array.isArray(binanceTakerRatio) || binanceTakerRatio.length === 0) return undefined;
      return binanceTakerRatio.map((d: any) => ({ date: new Date(d.timestamp).toISOString().split('T')[0], value: parseFloat(d.buySellRatio) }));
    })();

    let ohlcData: { date: string; high: number; low: number }[] = (hlData.hlCandles || []).map((cc) => ({ date: cc.date, high: cc.high, low: cc.low }));
    if (ohlcData.length === 0 && cgDailyOhlc.length > 0) ohlcData = cgDailyOhlc;

    // === BUILD PROFILE ===
    const profile = buildTokenProfile(
      id, symbol, priceData, fearGreedData, sentimentData,
      {
        socialVolume: toDateValue(socialVol), devActivity: toDateValue(devAct),
        mvrv: toDateValue(mvrv), exchangeBalance: toDateValue(exchangeBalance),
        activeAddresses: toDateValue(activeAddresses), networkGrowth: toDateValue(networkGrowth),
        whaleTransactions: toDateValue(whaleTransactions), nvt: toDateValue(nvt),
        socialDominance: toDateValue(socialDominance), devContributors: toDateValue(devContributors),
        fundingRate: binanceFundingDaily, openInterest: binanceOIDaily,
        longShortRatio: binanceLSDaily, takerBuySell: binanceTakerDaily,
        tvl: tvlData.length > 0 ? tvlData : undefined,
        hlFundingRate: hlData.funding, hlVolume: hlData.hlVolume,
        hlDailyRange: hlData.hlDailyRange, hlCandleBody: hlData.hlCandleBody,
        hlUpperWick: hlData.hlUpperWick, hlLowerWick: hlData.hlLowerWick,
        ...(onchainMetrics || {}),
      },
      ohlcData.length > 0 ? ohlcData : undefined,
    );

    const coinDetail = await getCoinDetail(id);
    if (coinDetail?.symbol) profile.symbol = coinDetail.symbol.toUpperCase();

    const responseData = {
      message: 'SUCCESS', status: 200, data: profile,
      meta: coinDetail ? { name: coinDetail.name, symbol: coinDetail.symbol, image: coinDetail.image?.large || coinDetail.image?.small || '' } : null,
      onchainEvents: onchainCached ? onchainCached.data.events : null,
      hasOnchain: onchainMetrics !== null,
      priceSeries: priceHistory.length > 0
        ? priceHistory.map(p => ({ date: p.time.split('T')[0], time: p.time, price: p.usd }))
        : priceData.map(p => ({ date: p.date, price: p.price })),
    };

    profileCache.set(id, { response: responseData, ts: Date.now(), hasOnchain: onchainMetrics !== null });
    return c.json(responseData);
  } catch (error: any) {
    console.error('[Profile]', error);
    return c.json({ message: `Failed to build profile: ${error?.message || 'Unknown error'}`, status: 500, data: null }, 500);
  }
});
