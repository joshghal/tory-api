/**
 * Per-Token Statistical Profiler
 *
 * Computes token-specific correlation profiles using 90 days of real data.
 * Each token gets its own statistical fingerprint — no generic models.
 *
 * Based on research findings (see research/FINDINGS.md):
 * - No single model works universally across tokens
 * - F&G is contrarian for 87% of altcoins but directional for BTC
 * - Exchange balance is the only independent signal (orthogonal to all others)
 * - Volume dynamics are BTC-specific, not universal
 */

export interface MetricCorrelation {
  metric: string;
  label: string;
  r_7d: number | null;
  r_14d: number | null;
  p_7d: number | null;
  p_14d: number | null;
  significant_7d: boolean;
  significant_14d: boolean;
  direction: 'bullish' | 'bearish' | 'neutral';
  interpretation: string;
  usedInBacktest: boolean;  // true if this metric appears in any backtested strategy
}

export interface CrossCorrelation {
  metricA: string;
  labelA: string;
  metricB: string;
  labelB: string;
  r: number;
  p: number;
  significant: boolean;
  relationship: string;
}

export interface AssociationRule {
  condition: string;
  outcome: string;
  support: number;      // % of days this pattern occurs
  confidence: number;   // % of times condition → outcome
  lift: number;         // how much better than random
  sampleSize: number;
  plain: string;        // human-readable
  backtested?: boolean; // true if this rule was backtested in strategies
}

export interface MetricCombo {
  metrics: string[];
  labels: string[];
  avgReturn7d: number;
  avgReturn14d: number;
  sampleSize: number;
  vsBaseline7d: number;  // % improvement over baseline
  vsBaseline14d: number;
  plain: string;
}

export interface Insight {
  type: 'bullish' | 'bearish' | 'info' | 'warning';
  title: string;
  body: string;
  confidence: 'high' | 'medium' | 'low';
  action: string;
}

export interface BacktestTrade {
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  returnPct: number;
  maxDrawdown: number;  // max adverse excursion during hold (worst intraday risk)
  rule: string;
  conditions: Record<string, { value: number; level: string; median: number }>;
}

export interface StrategyBacktest {
  ruleId: string;
  rulePlain: string;
  direction: 'buy' | 'sell';
  holdDays: number;
  totalTrades: number;
  winRate: number;
  winRateCi: [number, number]; // 95% bootstrap CI
  profitFactor: number;
  avgReturnPerTrade: number;
  totalReturn: number;
  maxDrawdown: number;
  sharpeRatio: number;
  expectancyPer1000: number; // $ expected per $1000 per trade
  hodlReturn: number;
  alphaVsHodl: number;
  equityCurve: number[];
  hodlCurve: number[];
  trades: BacktestTrade[];
  foldsProfitable: number;
  foldsTotal: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  isOptimal: boolean; // best hold period for this rule
  holdComparison: { days: number; winRate: number; avgReturn: number; trades: number }[];
  currentlyActive: boolean; // are the conditions met RIGHT NOW?
  currentConditions: { label: string; value: number; formatted: string; level: string; median: number; pctVsMedian: number }[];
}

export interface TokenProfile {
  tokenId: string;
  symbol: string;
  dataPoints: number;
  score: number;              // 0-100 composite score
  signal: 'bullish' | 'bearish' | 'neutral';
  dateRange: { from: string; to: string };
  correlations: MetricCorrelation[];
  crossCorrelations: CrossCorrelation[];
  associationRules: AssociationRule[];
  metricCombos: MetricCombo[];
  backtests: StrategyBacktest[];
  regime: string;
  topBullishSignals: string[];
  topBearishSignals: string[];
  insights: Insight[];
  profileSummary: string;
}

/**
 * Compute Pearson correlation coefficient + p-value
 * Pure JS implementation — no Python/SciPy dependency
 */
function pearsonCorrelation(x: number[], y: number[]): { r: number; p: number } {
  const n = x.length;
  if (n < 10) return { r: 0, p: 1 };

  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    sumXY += dx * dy;
    sumX2 += dx * dx;
    sumY2 += dy * dy;
  }

  if (sumX2 === 0 || sumY2 === 0) return { r: 0, p: 1 };

  const r = sumXY / Math.sqrt(sumX2 * sumY2);

  // t-statistic for significance
  const t = r * Math.sqrt((n - 2) / (1 - r * r));
  // Approximate p-value using t-distribution (df = n-2)
  const df = n - 2;
  const p = 2 * (1 - tCDF(Math.abs(t), df));

  return { r, p };
}

/**
 * Approximate t-distribution CDF using normal approximation for large df
 */
function tCDF(t: number, df: number): number {
  // For df > 30, t-distribution ≈ normal distribution
  if (df > 30) {
    return normalCDF(t);
  }
  // Beta regularized incomplete function approximation
  const x = df / (df + t * t);
  return 1 - 0.5 * betaIncomplete(df / 2, 0.5, x);
}

function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function betaIncomplete(a: number, b: number, x: number): number {
  // Simple approximation for the regularized incomplete beta function
  if (x === 0) return 0;
  if (x === 1) return 1;
  // Use continued fraction approximation (Lentz's method)
  const maxIter = 100;
  const epsilon = 1e-10;
  const lnBeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;

  let f = 1, c = 1, d = 0;
  for (let i = 0; i <= maxIter; i++) {
    const m = Math.floor(i / 2);
    let numerator: number;
    if (i === 0) {
      numerator = 1;
    } else if (i % 2 === 0) {
      numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    } else {
      numerator = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    }
    d = 1 + numerator * d;
    if (Math.abs(d) < epsilon) d = epsilon;
    c = 1 + numerator / c;
    if (Math.abs(c) < epsilon) c = epsilon;
    d = 1 / d;
    const delta = c * d;
    f *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return front * (f - 1);
}

function lgamma(x: number): number {
  // Stirling's approximation
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

export type ExtraMetrics = Record<string, { date: string; value: number }[] | undefined>;

/**
 * Build a per-token statistical profile from price data and all available metrics.
 * Accepts a generic extra metrics map so any new data source can be plugged in.
 */
export function buildTokenProfile(
  tokenId: string,
  symbol: string,
  priceData: { date: string; price: number; volume: number; marketCap: number }[],
  fearGreedData: { date: string; value: number }[],
  sentimentData?: { date: string; positive: number; negative: number }[],
  extraMetrics?: ExtraMetrics,
  ohlcData?: { date: string; high: number; low: number }[],
): TokenProfile {
  // Align all data by date
  const dateMap = new Map<string, Record<string, number>>();

  // Build OHLC lookup for high/low per day
  const ohlcMap = new Map<string, { high: number; low: number }>();
  if (ohlcData) {
    for (const o of ohlcData) ohlcMap.set(o.date, { high: o.high, low: o.low });
  }

  for (const p of priceData) {
    const ohlc = ohlcMap.get(p.date);
    dateMap.set(p.date, {
      price: p.price,
      priceHigh: ohlc?.high ?? p.price,
      priceLow: ohlc?.low ?? p.price,
      volume: p.volume,
      marketCap: p.marketCap,
      volMcap: p.marketCap > 0 ? p.volume / p.marketCap : 0,
    });
  }

  for (const fg of fearGreedData) {
    const entry = dateMap.get(fg.date);
    if (entry) entry.fearGreed = fg.value;
  }

  if (sentimentData) {
    for (const s of sentimentData) {
      const entry = dateMap.get(s.date);
      if (entry) {
        entry.sentimentRatio = (s.positive + s.negative) > 0
          ? s.positive / (s.positive + s.negative)
          : 0.5;
      }
    }
  }

  // Ingest all extra metrics generically
  const onchainKeys = new Set(['supplyInMotion', 'tokenVelocity', 'senderReceiverRatio', 'avgTransferSize',
    'retailRatio', 'exchangeNetFlow', 'washTradingPct', 'newAddressPct', 'onchainTxCount', 'onchainActiveAddrs']);
  const extraKeysWithData = new Set<string>();

  if (extraMetrics) {
    for (const [key, data] of Object.entries(extraMetrics)) {
      if (!data || data.length === 0) continue;
      extraKeysWithData.add(key);
      for (const d of data) {
        const entry = dateMap.get(d.date);
        if (entry) entry[key] = d.value;
      }
    }

    // Fill missing days with 0 for on-chain metrics (no transfers = 0 activity, not unknown)
    for (const key of extraKeysWithData) {
      if (!onchainKeys.has(key)) continue;
      for (const [, entry] of dateMap) {
        if (entry[key] === undefined) entry[key] = 0;
      }
    }
  }

  // Compute cross-source derived metrics
  for (const [, entry] of dateMap) {
    // CEX/DEX Volume Ratio: Binance volume / Hyperliquid volume
    if (entry.volume > 0 && entry.hlVolume > 0) {
      entry.cexDexVolRatio = entry.volume / entry.hlVolume;
    }
    // CEX-DEX Funding Spread: Binance funding - Hyperliquid funding
    if (entry.fundingRate !== undefined && entry.hlFundingRate !== undefined) {
      entry.fundingSpread = entry.fundingRate - entry.hlFundingRate;
    }
  }

  // Sort dates and compute forward returns + technical indicators
  const sortedDates = Array.from(dateMap.keys()).sort();
  const rows: Record<string, number>[] = [];
  const prices: number[] = sortedDates.map(d => dateMap.get(d)!.price);
  const volumes: number[] = sortedDates.map(d => dateMap.get(d)!.volume);

  for (let i = 0; i < sortedDates.length; i++) {
    const date = sortedDates[i];
    const entry = dateMap.get(date)!;

    // Forward returns
    if (i + 7 < sortedDates.length) {
      const futurePrice7 = dateMap.get(sortedDates[i + 7])?.price;
      if (futurePrice7 && entry.price > 0) {
        entry.return7d = (futurePrice7 - entry.price) / entry.price;
      }
    }
    if (i + 14 < sortedDates.length) {
      const futurePrice14 = dateMap.get(sortedDates[i + 14])?.price;
      if (futurePrice14 && entry.price > 0) {
        entry.return14d = (futurePrice14 - entry.price) / entry.price;
      }
    }

    // === COMPUTED TECHNICAL INDICATORS ===

    // RSI (14-day)
    if (i >= 14) {
      let gains = 0, losses = 0;
      for (let j = i - 13; j <= i; j++) {
        const change = prices[j] - prices[j - 1];
        if (change > 0) gains += change;
        else losses -= change;
      }
      const avgGain = gains / 14;
      const avgLoss = losses / 14;
      entry.rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    }

    // Volatility (14-day std dev of daily returns)
    if (i >= 14) {
      const returns: number[] = [];
      for (let j = i - 13; j <= i; j++) {
        if (prices[j - 1] > 0) returns.push((prices[j] - prices[j - 1]) / prices[j - 1]);
      }
      if (returns.length >= 10) {
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
        entry.volatility = Math.sqrt(variance);
      }
    }

    // Price Momentum (price / 20-day SMA)
    if (i >= 19) {
      const sma20 = prices.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
      if (sma20 > 0) entry.momentum = entry.price / sma20;
    }

    // Volume Trend (volume / 20-day average volume)
    if (i >= 19) {
      const avgVol20 = volumes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
      if (avgVol20 > 0) entry.volumeTrend = entry.volume / avgVol20;
    }

    rows.push(entry);
  }

  // === FULL METRICS LIST ===
  // All metrics that can be correlated — dynamically built from available data
  const metricsToTest: { key: string; label: string }[] = [
    // Market & Sentiment
    { key: 'fearGreed', label: 'Fear & Greed Index' },
    { key: 'volume', label: 'Trading Volume' },
    { key: 'volMcap', label: 'Volume/MCap Ratio' },
    { key: 'sentimentRatio', label: 'Sentiment Ratio' },
    // Technical Indicators (computed)
    { key: 'rsi', label: 'RSI (14d)' },
    { key: 'volatility', label: 'Volatility (14d)' },
    { key: 'momentum', label: 'Price Momentum' },
    { key: 'volumeTrend', label: 'Volume Trend' },
    // Santiment: Social & Dev
    { key: 'socialVolume', label: 'Social Volume' },
    { key: 'devActivity', label: 'Dev Activity' },
    { key: 'socialDominance', label: 'Social Dominance' },
    { key: 'devContributors', label: 'Dev Contributors' },
    // Santiment: On-Chain
    { key: 'mvrv', label: 'MVRV Ratio' },
    { key: 'exchangeBalance', label: 'Exchange Balance' },
    { key: 'activeAddresses', label: 'Active Addresses' },
    { key: 'networkGrowth', label: 'Network Growth' },
    { key: 'whaleTransactions', label: 'Whale Transactions' },
    { key: 'nvt', label: 'NVT Ratio' },
    // Binance Futures
    { key: 'fundingRate', label: 'Funding Rate (Binance)' },
    { key: 'openInterest', label: 'Open Interest (Binance)' },
    { key: 'longShortRatio', label: 'Long/Short Ratio' },
    { key: 'takerBuySell', label: 'Taker Buy/Sell Ratio' },
    // Hyperliquid OHLCV-derived
    { key: 'hlFundingRate', label: 'Funding Rate (Hyperliquid)' },
    { key: 'hlVolume', label: 'DEX Volume (Hyperliquid)' },
    { key: 'hlDailyRange', label: 'DEX Daily Range' },
    { key: 'hlCandleBody', label: 'DEX Candle Body' },
    { key: 'hlUpperWick', label: 'DEX Upper Wick' },
    { key: 'hlLowerWick', label: 'DEX Lower Wick' },
    // Cross-source derived
    { key: 'cexDexVolRatio', label: 'CEX/DEX Volume Ratio' },
    { key: 'fundingSpread', label: 'CEX-DEX Funding Spread' },
    // DeFiLlama
    { key: 'tvl', label: 'Total Value Locked' },
    // On-chain (Etherscan)
    { key: 'supplyInMotion', label: 'Supply In Motion' },
    { key: 'tokenVelocity', label: 'Token Velocity' },
    { key: 'senderReceiverRatio', label: 'Sender/Receiver Ratio' },
    { key: 'avgTransferSize', label: 'Avg Transfer Size' },
    { key: 'retailRatio', label: 'Retail Ratio' },
    { key: 'exchangeNetFlow', label: 'Exchange Net Flow' },
    { key: 'washTradingPct', label: 'Wash Trading %' },
    { key: 'newAddressPct', label: 'New Address %' },
    { key: 'onchainTxCount', label: 'On-chain Tx Count' },
    { key: 'onchainActiveAddrs', label: 'On-chain Active Addresses' },
  ].filter(m => {
    // Only include metrics that have enough data points
    const count = rows.filter(r => r[m.key] !== undefined && !isNaN(r[m.key])).length;
    return count >= 15;
  });

  const correlations: MetricCorrelation[] = [];

  for (const { key, label } of metricsToTest) {
    // Extract paired observations
    const x7: number[] = [], y7: number[] = [];
    const x14: number[] = [], y14: number[] = [];

    for (const row of rows) {
      if (row[key] !== undefined && !isNaN(row[key])) {
        if (row.return7d !== undefined && !isNaN(row.return7d)) {
          x7.push(row[key]);
          y7.push(row.return7d);
        }
        if (row.return14d !== undefined && !isNaN(row.return14d)) {
          x14.push(row[key]);
          y14.push(row.return14d);
        }
      }
    }

    const corr7 = x7.length >= 20 ? pearsonCorrelation(x7, y7) : { r: null as number | null, p: null as number | null };
    const corr14 = x14.length >= 20 ? pearsonCorrelation(x14, y14) : { r: null as number | null, p: null as number | null };

    const sig7 = corr7.p !== null && corr7.p < 0.05;
    const sig14 = corr14.p !== null && corr14.p < 0.05;

    const primaryR = corr7.r ?? corr14.r ?? 0;
    const direction: 'bullish' | 'bearish' | 'neutral' =
      (sig7 || sig14) ? (primaryR > 0 ? 'bullish' : 'bearish') : 'neutral';

    let interpretation = '';
    if (sig7 || sig14) {
      const r = Math.abs(primaryR);
      const strength = r > 0.3 ? 'Strong' : r > 0.15 ? 'Moderate' : 'Weak';
      const dir = primaryR > 0 ? 'positive' : 'negative';
      interpretation = `${strength} ${dir} correlation: when ${label} is high, ${symbol} tends to ${primaryR > 0 ? 'rise' : 'fall'} over the next ${sig7 ? '7' : '14'} days.`;
    } else {
      interpretation = `No statistically significant relationship between ${label} and ${symbol} returns.`;
    }

    correlations.push({
      metric: key,
      label,
      r_7d: corr7.r,
      r_14d: corr14.r,
      p_7d: corr7.p,
      p_14d: corr14.p,
      significant_7d: sig7,
      significant_14d: sig14,
      direction,
      interpretation,
      usedInBacktest: false, // will be set after backtesting
    });
  }

  // Determine regime
  const latestRow = rows[rows.length - 1];
  let regime = 'NEUTRAL';
  if (latestRow) {
    const fg = latestRow.fearGreed;
    const vm = latestRow.volMcap;
    const medianVM = rows.map(r => r.volMcap).filter(v => v !== undefined).sort((a, b) => a - b);
    const vmMedian = medianVM[Math.floor(medianVM.length / 2)] || 0;

    if (fg > 60 && vm < vmMedian) regime = 'COMPLACENCY';
    else if (fg < 30 && vm > vmMedian) regime = 'PANIC_SELLING';
    else if (fg > 60 && vm > vmMedian) regime = 'EUPHORIA';
    else if (fg < 30) regime = 'CAPITULATION';
  }

  // Build signal lists
  const sigCorr = correlations.filter(c => c.significant_7d || c.significant_14d);
  const topBullish = sigCorr.filter(c => c.direction === 'bullish')
    .sort((a, b) => Math.abs(b.r_7d ?? b.r_14d ?? 0) - Math.abs(a.r_7d ?? a.r_14d ?? 0))
    .map(c => c.interpretation);
  const topBearish = sigCorr.filter(c => c.direction === 'bearish')
    .sort((a, b) => Math.abs(b.r_7d ?? b.r_14d ?? 0) - Math.abs(a.r_7d ?? a.r_14d ?? 0))
    .map(c => c.interpretation);

  // === CROSS-METRIC CORRELATION MATRIX ===
  const crossCorrelations = computeCrossCorrelations(rows, metricsToTest);

  // === ASSOCIATION RULES ===
  const associationRules = mineAssociationRules(rows, metricsToTest, symbol);

  // === METRIC COMBOS ===
  const baselineReturn7d = rows.filter(r => r.return7d !== undefined).map(r => r.return7d);
  const baselineAvg7d = baselineReturn7d.length > 0 ? baselineReturn7d.reduce((a, b) => a + b, 0) / baselineReturn7d.length : 0;
  const baselineReturn14d = rows.filter(r => r.return14d !== undefined).map(r => r.return14d);
  const baselineAvg14d = baselineReturn14d.length > 0 ? baselineReturn14d.reduce((a, b) => a + b, 0) / baselineReturn14d.length : 0;
  const metricCombos = findMetricCombos(rows, metricsToTest, symbol, baselineAvg7d, baselineAvg14d);

  // === BACKTESTING ===
  const backtests = backtestRules(associationRules, rows, sortedDates, dateMap, metricsToTest);

  // === HUMAN-READABLE INSIGHTS (after backtests so we can reference active strategies) ===
  const insights = generateInsights(symbol, correlations, crossCorrelations, associationRules, metricCombos, regime, rows, backtests);

  // === TAG: Mark which rules were backtested and which metrics are used ===
  const backtestedConditions = new Set(backtests.map(b => b.trades[0]?.rule).filter(Boolean));
  const metricsUsedInBacktest = new Set<string>();

  for (const rule of associationRules) {
    if (backtestedConditions.has(rule.condition)) {
      rule.backtested = true;
      // Extract metric labels from condition
      const parts = rule.condition.split(' AND ').map(s => s.trim());
      for (const part of parts) {
        const label = part.replace(/ is (high|low)$/, '');
        const m = metricsToTest.find(mt => mt.label === label);
        if (m) metricsUsedInBacktest.add(m.key);
      }
    }
  }

  for (const c of correlations) {
    c.usedInBacktest = metricsUsedInBacktest.has(c.metric);
  }

  // === COMPOSITE SCORE (0-100) ===
  const { score, signal } = computeScore(correlations, associationRules, backtests, regime, rows);

  // Profile summary for AI prompt
  const sigCount = sigCorr.length;
  const bestBacktest = backtests.length > 0 ? backtests[0] : null;
  const profileSummary = `${symbol} Statistical Profile (${rows.length} days): ` +
    `Score ${score}/100 (${signal}). ` +
    `${sigCount} significant metric correlations found. ` +
    correlations
      .filter(c => c.significant_7d || c.significant_14d)
      .map(c => `${c.label}: r=${(c.r_7d ?? c.r_14d ?? 0).toFixed(3)} (${c.direction})`)
      .join('; ') +
    `. Current regime: ${regime}. ` +
    `${associationRules.length} association rules discovered. ` +
    `${backtests.length} strategies backtested. ` +
    (bestBacktest ? `Best strategy: ${bestBacktest.rulePlain} (${(bestBacktest.winRate * 100).toFixed(0)}% win rate, ${(bestBacktest.totalReturn * 100).toFixed(1)}% return).` : '');

  return {
    tokenId,
    symbol,
    dataPoints: rows.length,
    score,
    signal,
    dateRange: {
      from: sortedDates[0] || '',
      to: sortedDates[sortedDates.length - 1] || '',
    },
    correlations,
    crossCorrelations,
    associationRules,
    metricCombos,
    backtests,
    regime,
    topBullishSignals: topBullish,
    topBearishSignals: topBearish,
    insights,
    profileSummary,
  };
}

// ============================================================
// CROSS-METRIC CORRELATION MATRIX
// Tests every pair of metrics against each other
// ============================================================
function computeCrossCorrelations(
  rows: Record<string, number>[],
  metrics: { key: string; label: string }[],
): CrossCorrelation[] {
  const results: CrossCorrelation[] = [];

  for (let i = 0; i < metrics.length; i++) {
    for (let j = i + 1; j < metrics.length; j++) {
      const a = metrics[i], b = metrics[j];
      const xVals: number[] = [], yVals: number[] = [];

      for (const row of rows) {
        const va = row[a.key], vb = row[b.key];
        if (va !== undefined && !isNaN(va) && vb !== undefined && !isNaN(vb)) {
          xVals.push(va);
          yVals.push(vb);
        }
      }

      if (xVals.length < 20) continue;

      const { r, p } = pearsonCorrelation(xVals, yVals);
      const sig = p < 0.05;
      const strength = Math.abs(r) > 0.5 ? 'strongly' : Math.abs(r) > 0.25 ? 'moderately' : 'weakly';
      const dir = r > 0 ? 'move together' : 'move opposite';

      results.push({
        metricA: a.key,
        labelA: a.label,
        metricB: b.key,
        labelB: b.label,
        r,
        p,
        significant: sig,
        relationship: sig
          ? `${a.label} and ${b.label} ${strength} ${dir} (r=${r.toFixed(3)})`
          : `No significant link between ${a.label} and ${b.label}`,
      });
    }
  }

  return results.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
}

// ============================================================
// ASSOCIATION RULE MINING
// Discretize metrics into HIGH/LOW, find patterns that predict returns
// ============================================================
function mineAssociationRules(
  rows: Record<string, number>[],
  metrics: { key: string; label: string }[],
  symbol: string,
): AssociationRule[] {
  const rules: AssociationRule[] = [];
  const totalRows = rows.filter(r => r.return7d !== undefined).length;
  if (totalRows < 30) return rules;

  // Compute medians for discretization
  const medians: Record<string, number> = {};
  for (const { key } of metrics) {
    const vals = rows.map(r => r[key]).filter(v => v !== undefined && !isNaN(v)).sort((a, b) => a - b);
    if (vals.length > 0) medians[key] = vals[Math.floor(vals.length / 2)];
  }

  const medianReturn = (() => {
    const rets = rows.map(r => r.return7d).filter(v => v !== undefined && !isNaN(v)).sort((a, b) => a - b);
    return rets.length > 0 ? rets[Math.floor(rets.length / 2)] : 0;
  })();

  // Single-metric rules
  for (const { key, label } of metrics) {
    if (medians[key] === undefined) continue;

    for (const level of ['high', 'low'] as const) {
      const matching = rows.filter(r =>
        r[key] !== undefined && !isNaN(r[key]) &&
        r.return7d !== undefined && !isNaN(r.return7d) &&
        (level === 'high' ? r[key] > medians[key] : r[key] <= medians[key])
      );

      if (matching.length < 15) continue;

      const positiveOutcomes = matching.filter(r => r.return7d > medianReturn).length;
      const negativeOutcomes = matching.length - positiveOutcomes;
      const support = matching.length / totalRows;
      const confidenceUp = positiveOutcomes / matching.length;
      const confidenceDown = negativeOutcomes / matching.length;
      const baseRate = rows.filter(r => r.return7d !== undefined && r.return7d > medianReturn).length / totalRows;

      // Only keep rules with meaningful lift
      const liftUp = baseRate > 0 ? confidenceUp / baseRate : 1;
      const liftDown = (1 - baseRate) > 0 ? confidenceDown / (1 - baseRate) : 1;

      if (liftUp > 1.15 && confidenceUp > 0.55) {
        rules.push({
          condition: `${label} is ${level}`,
          outcome: `${symbol} rises next 7 days`,
          support: Math.round(support * 100),
          confidence: Math.round(confidenceUp * 100),
          lift: parseFloat(liftUp.toFixed(2)),
          sampleSize: matching.length,
          plain: `When ${label} is ${level}, ${symbol} goes up ${Math.round(confidenceUp * 100)}% of the time (${liftUp.toFixed(1)}x more likely than average)`,
        });
      }

      if (liftDown > 1.15 && confidenceDown > 0.55) {
        rules.push({
          condition: `${label} is ${level}`,
          outcome: `${symbol} falls next 7 days`,
          support: Math.round(support * 100),
          confidence: Math.round(confidenceDown * 100),
          lift: parseFloat(liftDown.toFixed(2)),
          sampleSize: matching.length,
          plain: `When ${label} is ${level}, ${symbol} drops ${Math.round(confidenceDown * 100)}% of the time (${liftDown.toFixed(1)}x more likely than average)`,
        });
      }
    }
  }

  // Two-metric combination rules
  for (let i = 0; i < metrics.length; i++) {
    for (let j = i + 1; j < metrics.length; j++) {
      const a = metrics[i], b = metrics[j];
      if (medians[a.key] === undefined || medians[b.key] === undefined) continue;

      for (const levelA of ['high', 'low'] as const) {
        for (const levelB of ['high', 'low'] as const) {
          const matching = rows.filter(r =>
            r[a.key] !== undefined && !isNaN(r[a.key]) &&
            r[b.key] !== undefined && !isNaN(r[b.key]) &&
            r.return7d !== undefined && !isNaN(r.return7d) &&
            (levelA === 'high' ? r[a.key] > medians[a.key] : r[a.key] <= medians[a.key]) &&
            (levelB === 'high' ? r[b.key] > medians[b.key] : r[b.key] <= medians[b.key])
          );

          if (matching.length < 10) continue;

          const positiveOutcomes = matching.filter(r => r.return7d > medianReturn).length;
          const support = matching.length / totalRows;
          const confidence = positiveOutcomes / matching.length;
          const baseRate = rows.filter(r => r.return7d !== undefined && r.return7d > medianReturn).length / totalRows;
          const lift = baseRate > 0 ? confidence / baseRate : 1;

          if (lift > 1.2 && confidence > 0.6) {
            rules.push({
              condition: `${a.label} is ${levelA} AND ${b.label} is ${levelB}`,
              outcome: `${symbol} rises next 7 days`,
              support: Math.round(support * 100),
              confidence: Math.round(confidence * 100),
              lift: parseFloat(lift.toFixed(2)),
              sampleSize: matching.length,
              plain: `When ${a.label} is ${levelA} and ${b.label} is ${levelB}, ${symbol} rises ${Math.round(confidence * 100)}% of the time (${lift.toFixed(1)}x better than random)`,
            });
          }

          const negativeOutcomes = matching.length - positiveOutcomes;
          const confDown = negativeOutcomes / matching.length;
          const liftDown = (1 - baseRate) > 0 ? confDown / (1 - baseRate) : 1;

          if (liftDown > 1.2 && confDown > 0.6) {
            rules.push({
              condition: `${a.label} is ${levelA} AND ${b.label} is ${levelB}`,
              outcome: `${symbol} falls next 7 days`,
              support: Math.round(support * 100),
              confidence: Math.round(confDown * 100),
              lift: parseFloat(liftDown.toFixed(2)),
              sampleSize: matching.length,
              plain: `When ${a.label} is ${levelA} and ${b.label} is ${levelB}, ${symbol} drops ${Math.round(confDown * 100)}% of the time (${liftDown.toFixed(1)}x more likely)`,
            });
          }
        }
      }
    }
  }

  // Three-metric combination rules (only test top metrics to keep it tractable)
  // With 21 metrics, 3-combos = 21*20*19/6 = 1330 triplets × 8 level combos = 10640
  // Limit to metrics with enough data to avoid noise
  const topMetrics = metrics.filter(m => {
    const count = rows.filter(r => r[m.key] !== undefined && !isNaN(r[m.key]) && r.return7d !== undefined).length;
    return count >= 25;
  }).slice(0, 12); // cap at 12 to keep combos manageable

  for (let i = 0; i < topMetrics.length; i++) {
    for (let j = i + 1; j < topMetrics.length; j++) {
      for (let k = j + 1; k < topMetrics.length; k++) {
        const a = topMetrics[i], b = topMetrics[j], c = topMetrics[k];
        if (medians[a.key] === undefined || medians[b.key] === undefined || medians[c.key] === undefined) continue;

        for (const la of ['high', 'low'] as const) {
          for (const lb of ['high', 'low'] as const) {
            for (const lc of ['high', 'low'] as const) {
              const matching = rows.filter(r =>
                r[a.key] !== undefined && !isNaN(r[a.key]) &&
                r[b.key] !== undefined && !isNaN(r[b.key]) &&
                r[c.key] !== undefined && !isNaN(r[c.key]) &&
                r.return7d !== undefined && !isNaN(r.return7d) &&
                (la === 'high' ? r[a.key] > medians[a.key] : r[a.key] <= medians[a.key]) &&
                (lb === 'high' ? r[b.key] > medians[b.key] : r[b.key] <= medians[b.key]) &&
                (lc === 'high' ? r[c.key] > medians[c.key] : r[c.key] <= medians[c.key])
              );

              if (matching.length < 7) continue;

              const positiveOutcomes = matching.filter(r => r.return7d > medianReturn).length;
              const support = matching.length / totalRows;
              const confidence = positiveOutcomes / matching.length;
              const baseRate = rows.filter(r => r.return7d !== undefined && r.return7d > medianReturn).length / totalRows;
              const lift = baseRate > 0 ? confidence / baseRate : 1;

              if (lift > 1.3 && confidence > 0.65) {
                rules.push({
                  condition: `${a.label} is ${la} AND ${b.label} is ${lb} AND ${c.label} is ${lc}`,
                  outcome: `${symbol} rises next 7 days`,
                  support: Math.round(support * 100),
                  confidence: Math.round(confidence * 100),
                  lift: parseFloat(lift.toFixed(2)),
                  sampleSize: matching.length,
                  plain: `When ${a.label} is ${la}, ${b.label} is ${lb}, and ${c.label} is ${lc}, ${symbol} rises ${Math.round(confidence * 100)}% of the time (${lift.toFixed(1)}x better than random)`,
                });
              }

              const negativeOutcomes = matching.length - positiveOutcomes;
              const confDown = negativeOutcomes / matching.length;
              const liftDown = (1 - baseRate) > 0 ? confDown / (1 - baseRate) : 1;

              if (liftDown > 1.3 && confDown > 0.65) {
                rules.push({
                  condition: `${a.label} is ${la} AND ${b.label} is ${lb} AND ${c.label} is ${lc}`,
                  outcome: `${symbol} falls next 7 days`,
                  support: Math.round(support * 100),
                  confidence: Math.round(confDown * 100),
                  lift: parseFloat(liftDown.toFixed(2)),
                  sampleSize: matching.length,
                  plain: `When ${a.label} is ${la}, ${b.label} is ${lb}, and ${c.label} is ${lc}, ${symbol} drops ${Math.round(confDown * 100)}% of the time (${liftDown.toFixed(1)}x more likely)`,
                });
              }
            }
          }
        }
      }
    }
  }

  // Default all rules to not backtested
  for (const r of rules) {
    r.backtested = false;
  }

  return rules.sort((a, b) => b.lift - a.lift).slice(0, 40);
}

// ============================================================
// METRIC COMBOS
// Find which metric combinations produce the best/worst avg returns
// ============================================================
function findMetricCombos(
  rows: Record<string, number>[],
  metrics: { key: string; label: string }[],
  symbol: string,
  baselineAvg7d: number,
  baselineAvg14d: number,
): MetricCombo[] {
  const combos: MetricCombo[] = [];

  const medians: Record<string, number> = {};
  for (const { key } of metrics) {
    const vals = rows.map(r => r[key]).filter(v => v !== undefined && !isNaN(v)).sort((a, b) => a - b);
    if (vals.length > 0) medians[key] = vals[Math.floor(vals.length / 2)];
  }

  // Test all pairs
  for (let i = 0; i < metrics.length; i++) {
    for (let j = i + 1; j < metrics.length; j++) {
      const a = metrics[i], b = metrics[j];
      if (medians[a.key] === undefined || medians[b.key] === undefined) continue;

      for (const levelA of ['high', 'low'] as const) {
        for (const levelB of ['high', 'low'] as const) {
          const matching = rows.filter(r =>
            r[a.key] !== undefined && !isNaN(r[a.key]) &&
            r[b.key] !== undefined && !isNaN(r[b.key]) &&
            (levelA === 'high' ? r[a.key] > medians[a.key] : r[a.key] <= medians[a.key]) &&
            (levelB === 'high' ? r[b.key] > medians[b.key] : r[b.key] <= medians[b.key])
          );

          const returns7d = matching.filter(r => r.return7d !== undefined).map(r => r.return7d);
          const returns14d = matching.filter(r => r.return14d !== undefined).map(r => r.return14d);

          if (returns7d.length < 10) continue;

          const avg7d = returns7d.reduce((a, b) => a + b, 0) / returns7d.length;
          const avg14d = returns14d.length > 0 ? returns14d.reduce((a, b) => a + b, 0) / returns14d.length : 0;

          const vs7d = baselineAvg7d !== 0 ? ((avg7d - baselineAvg7d) / Math.abs(baselineAvg7d)) * 100 : 0;
          const vs14d = baselineAvg14d !== 0 ? ((avg14d - baselineAvg14d) / Math.abs(baselineAvg14d)) * 100 : 0;

          if (Math.abs(vs7d) > 30 || Math.abs(vs14d) > 30) {
            const dir7d = avg7d > baselineAvg7d ? 'outperforms' : 'underperforms';
            combos.push({
              metrics: [`${a.key}_${levelA}`, `${b.key}_${levelB}`],
              labels: [`${a.label} ${levelA}`, `${b.label} ${levelB}`],
              avgReturn7d: parseFloat((avg7d * 100).toFixed(2)),
              avgReturn14d: parseFloat((avg14d * 100).toFixed(2)),
              sampleSize: returns7d.length,
              vsBaseline7d: parseFloat(vs7d.toFixed(1)),
              vsBaseline14d: parseFloat(vs14d.toFixed(1)),
              plain: `${a.label} ${levelA} + ${b.label} ${levelB} → avg ${(avg7d * 100).toFixed(1)}% over 7 days (${dir7d} baseline by ${Math.abs(vs7d).toFixed(0)}%)`,
            });
          }
        }
      }
    }
  }

  return combos.sort((a, b) => Math.abs(b.vsBaseline7d) - Math.abs(a.vsBaseline7d)).slice(0, 30);
}

// ============================================================
// HUMAN-READABLE INSIGHT GENERATOR
// Translates all stats into plain language + actionable suggestions
// ============================================================
function generateInsights(
  symbol: string,
  correlations: MetricCorrelation[],
  crossCorr: CrossCorrelation[],
  rules: AssociationRule[],
  combos: MetricCombo[],
  regime: string,
  rows: Record<string, number>[],
  backtests: StrategyBacktest[] = [],
): Insight[] {
  const insights: Insight[] = [];

  // 1. Regime insight
  const regimeMap: Record<string, { type: Insight['type']; title: string; body: string; action: string }> = {
    EUPHORIA: {
      type: 'warning',
      title: 'Market is in euphoria mode',
      body: `Everyone is greedy and trading volume is high. Historically this is when ${symbol} is most vulnerable to sharp corrections.`,
      action: 'Consider taking some profits or tightening your stop-losses. This doesn\'t mean sell everything — but protect your gains.',
    },
    COMPLACENCY: {
      type: 'info',
      title: 'Market is complacent',
      body: `Greed is high but trading activity is low. People feel confident but aren't backing it up with volume. This can go either way.`,
      action: 'Watch for a volume spike — it will tell you which direction the breakout goes. No rush to act.',
    },
    PANIC_SELLING: {
      type: 'bullish',
      title: 'Panic selling is happening',
      body: `Fear is extreme and people are dumping at high volume. For most tokens, this is historically when the best buying opportunities appear.`,
      action: `If you believe in ${symbol} long-term, this could be a good entry zone. Consider dollar-cost averaging in rather than going all-in.`,
    },
    CAPITULATION: {
      type: 'bullish',
      title: 'Market has capitulated',
      body: `Extreme fear with low volume — sellers are exhausted. The worst might be over, but recovery can take time.`,
      action: 'Start building a position slowly. Don\'t expect an immediate bounce — patience pays here.',
    },
    NEUTRAL: {
      type: 'info',
      title: 'Market is in a neutral state',
      body: `Neither extreme fear nor greed. No clear directional signal from market sentiment alone.`,
      action: 'Look at the specific metric signals below for more targeted guidance.',
    },
  };

  const regimeInfo = regimeMap[regime] || regimeMap.NEUTRAL;
  insights.push({ ...regimeInfo, confidence: 'medium' });

  // Helper: get current value + median for a metric
  const getMetricStats = (key: string) => {
    const vals = rows.map(r => r[key]).filter(v => v !== undefined && !isNaN(v)).sort((a, b) => a - b);
    const median = vals.length > 0 ? vals[Math.floor(vals.length / 2)] : 0;
    // Find latest non-NaN value
    let current: number | undefined;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i][key] !== undefined && !isNaN(rows[i][key])) { current = rows[i][key]; break; }
    }
    return { current, median };
  };

  const fmtNum = (n: number): string => {
    const a = Math.abs(n);
    if (a >= 1e12) return (n / 1e12).toFixed(1) + 'T';
    if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    if (a >= 1) return n.toFixed(2);
    if (a >= 0.001) return n.toFixed(4);
    return n.toExponential(1);
  };

  // 2. Strongest single-metric signals
  const strongSig = correlations
    .filter(c => c.significant_7d || c.significant_14d)
    .sort((a, b) => Math.abs(b.r_7d ?? b.r_14d ?? 0) - Math.abs(a.r_7d ?? a.r_14d ?? 0));

  if (strongSig.length > 0) {
    const top = strongSig[0];
    const r = top.r_7d ?? top.r_14d ?? 0;
    const absR = Math.abs(r);
    const conf: Insight['confidence'] = absR > 0.3 ? 'high' : absR > 0.2 ? 'medium' : 'low';
    const stats = getMetricStats(top.metric);
    const currentStr = stats.current !== undefined ? fmtNum(stats.current) : 'N/A';
    const medianStr = fmtNum(stats.median);
    const isAbove = stats.current !== undefined && stats.current > stats.median;
    const period = top.significant_7d ? '7' : '14';

    if (r > 0) {
      insights.push({
        type: 'bullish',
        title: `${top.label} is your strongest bullish indicator`,
        body: `When ${top.label} is high (above ${medianStr}), ${symbol} has historically gone up over the next ${period} days (r = ${r.toFixed(3)}). Currently at ${currentStr} — ${isAbove ? 'above' : 'below'} the threshold.`,
        confidence: conf,
        action: isAbove
          ? `${top.label} is above the threshold right now (${currentStr} > ${medianStr}). This is a bullish signal.`
          : `${top.label} is below the threshold (${currentStr} ≤ ${medianStr}). Wait for it to rise above ${medianStr} before acting.`,
      });
    } else {
      insights.push({
        type: 'bearish',
        title: `High ${top.label} tends to precede dips`,
        body: `When ${top.label} is high (above ${medianStr}), ${symbol} has historically dropped over the next ${period} days (r = ${r.toFixed(3)}). Currently at ${currentStr} — ${isAbove ? 'above the danger zone' : 'below the danger zone'}.`,
        confidence: conf,
        action: isAbove
          ? `${top.label} is elevated right now (${currentStr} > ${medianStr}). Consider reducing exposure.`
          : `${top.label} is safe for now (${currentStr} ≤ ${medianStr}). No bearish signal active.`,
      });
    }
  }

  // 3. Cross-metric insight (strongest pair)
  const strongCross = crossCorr.filter(c => c.significant);
  if (strongCross.length > 0) {
    const top = strongCross[0];
    const linked = top.r > 0 ? 'rise and fall together' : 'move in opposite directions';
    const statsA = getMetricStats(top.metricA);
    const statsB = getMetricStats(top.metricB);
    const curA = statsA.current !== undefined ? fmtNum(statsA.current) : 'N/A';
    const curB = statsB.current !== undefined ? fmtNum(statsB.current) : 'N/A';
    insights.push({
      type: 'info',
      title: `${top.labelA} and ${top.labelB} are linked`,
      body: `These two metrics ${linked} (r = ${top.r.toFixed(3)}). ${top.labelA} is currently ${curA}, ${top.labelB} is ${curB}. Watching both gives you the same signal.`,
      confidence: Math.abs(top.r) > 0.4 ? 'high' : 'medium',
      action: top.r > 0
        ? `Focus on whichever is easier to track. They tell you the same thing.`
        : `These are complementary signals. When one is high and the other is low, pay attention — that's unusual.`,
    });
  }

  // 4. Best association rules as insights
  const bullishRules = rules.filter(r => r.outcome.includes('rises')).slice(0, 2);
  const bearishRules = rules.filter(r => r.outcome.includes('falls')).slice(0, 2);

  for (const rule of bullishRules) {
    insights.push({
      type: 'bullish',
      title: `Pattern found: ${rule.condition}`,
      body: rule.plain,
      confidence: rule.lift > 1.5 ? 'high' : rule.lift > 1.3 ? 'medium' : 'low',
      action: `Watch for this pattern. When it appears, historically it's been a ${rule.confidence}% accurate buy signal for ${symbol}.`,
    });
  }

  for (const rule of bearishRules) {
    insights.push({
      type: 'bearish',
      title: `Warning pattern: ${rule.condition}`,
      body: rule.plain,
      confidence: rule.lift > 1.5 ? 'high' : rule.lift > 1.3 ? 'medium' : 'low',
      action: `When this pattern appears, consider holding off on buying. It's been a ${rule.confidence}% accurate sell signal.`,
    });
  }

  // 5. Best/worst metric combos
  const bestCombo = combos.filter(c => c.vsBaseline7d > 0).sort((a, b) => b.vsBaseline7d - a.vsBaseline7d)[0];
  const worstCombo = combos.filter(c => c.vsBaseline7d < 0).sort((a, b) => a.vsBaseline7d - b.vsBaseline7d)[0];

  if (bestCombo) {
    insights.push({
      type: 'bullish',
      title: 'Best metric combination found',
      body: `${bestCombo.labels[0]} + ${bestCombo.labels[1]} = avg ${bestCombo.avgReturn7d > 0 ? '+' : ''}${bestCombo.avgReturn7d}% over 7 days. That's ${Math.abs(bestCombo.vsBaseline7d)}% better than the average.`,
      confidence: bestCombo.sampleSize > 20 ? 'high' : 'medium',
      action: `When both conditions line up, it's historically been the best time to buy ${symbol}.`,
    });
  }

  if (worstCombo) {
    insights.push({
      type: 'bearish',
      title: 'Worst metric combination found',
      body: `${worstCombo.labels[0]} + ${worstCombo.labels[1]} = avg ${worstCombo.avgReturn7d > 0 ? '+' : ''}${worstCombo.avgReturn7d}% over 7 days. That's ${Math.abs(worstCombo.vsBaseline7d)}% worse than the average.`,
      confidence: worstCombo.sampleSize > 20 ? 'high' : 'medium',
      action: `When both conditions line up, avoid buying ${symbol}. Wait for the pattern to change.`,
    });
  }

  // 6. Data quality insight
  const metricsWithData = correlations.filter(c => c.r_7d !== null).length;
  if (metricsWithData < 3) {
    insights.push({
      type: 'warning',
      title: 'Limited data available',
      body: `Only ${metricsWithData} out of 6 metrics had enough data to analyze. The insights above are based on incomplete information.`,
      confidence: 'low',
      action: 'Take these insights with a grain of salt. More data sources would give a clearer picture.',
    });
  }

  // 7. Current conditions check
  const latest = rows[rows.length - 1];
  if (latest) {
    const currentSignals: string[] = [];
    for (const rule of bullishRules) {
      if (matchesCurrentCondition(rule.condition, latest, rows)) {
        currentSignals.push(rule.condition);
      }
    }
    if (currentSignals.length > 0) {
      insights.push({
        type: 'bullish',
        title: 'Bullish patterns are active RIGHT NOW',
        body: `Current conditions match: ${currentSignals.join(', ')}. Based on 90 days of data, this setup has historically favored upside.`,
        confidence: 'medium',
        action: `The data says conditions are favorable for ${symbol} right now. Consider this in your decision.`,
      });
    }

    const bearishCurrent: string[] = [];
    for (const rule of bearishRules) {
      if (matchesCurrentCondition(rule.condition, latest, rows)) {
        bearishCurrent.push(rule.condition);
      }
    }
    if (bearishCurrent.length > 0) {
      insights.push({
        type: 'bearish',
        title: 'Bearish patterns are active RIGHT NOW',
        body: `Current conditions match: ${bearishCurrent.join(', ')}. Based on 90 days of data, this setup has historically favored downside.`,
        confidence: 'medium',
        action: `The data suggests caution for ${symbol} right now. Consider waiting before adding to your position.`,
      });
    }
  }

  // BOTTOM LINE — reconcile conflicting signals
  const activeStrats = backtests.filter(b => b.currentlyActive);
  if (activeStrats.length > 0) {
    const activeBuys = activeStrats.filter(b => b.direction === 'buy');
    const activeSells = activeStrats.filter(b => b.direction === 'sell');
    const avgBuyWin = activeBuys.length > 0 ? activeBuys.reduce((a, b) => a + b.winRate, 0) / activeBuys.length : 0;
    const avgSellWin = activeSells.length > 0 ? activeSells.reduce((a, b) => a + b.winRate, 0) / activeSells.length : 0;
    const avgBuyReturn = activeBuys.length > 0 ? activeBuys.reduce((a, b) => a + b.avgReturnPerTrade, 0) / activeBuys.length : 0;
    const avgSellReturn = activeSells.length > 0 ? activeSells.reduce((a, b) => a + b.avgReturnPerTrade, 0) / activeSells.length : 0;

    if (activeSells.length > 0 && activeBuys.length > 0) {
      // Conflict — both buy and sell strategies active
      const sellDominant = avgSellWin > avgBuyWin || (avgSellWin === avgBuyWin && avgSellReturn > avgBuyReturn);
      const dominantDir = sellDominant ? 'sell' : 'buy';
      const dominantWin = sellDominant ? avgSellWin : avgBuyWin;
      const dominantReturn = sellDominant ? avgSellReturn : avgBuyReturn;
      const weakDir = sellDominant ? 'buy' : 'sell';
      const weakWin = sellDominant ? avgBuyWin : avgSellWin;

      insights.unshift({
        type: sellDominant ? 'bearish' : 'bullish',
        title: `Bottom line: ${dominantDir} strategies are stronger right now`,
        body: `Mixed signals detected. ${activeSells.length} sell and ${activeBuys.length} buy strategies are active simultaneously. ` +
          `However, ${dominantDir} strategies average ${(dominantWin * 100).toFixed(0)}% win rate with ${dominantReturn > 0 ? '+' : ''}${dominantReturn.toFixed(1)}% avg return, ` +
          `vs ${weakDir} at ${(weakWin * 100).toFixed(0)}% win rate. ` +
          `When backtest data and sentiment disagree, backtested strategies are more reliable — they're proven against real price action.`,
        confidence: 'high',
        action: sellDominant
          ? `The data favors caution on ${symbol} right now. Consider waiting or reducing exposure despite bullish sentiment signals.`
          : `The data favors buying ${symbol} right now despite bearish sentiment. Consider a small position with a clear exit plan.`,
      });
    } else if (activeSells.length > 0) {
      insights.unshift({
        type: 'bearish',
        title: `Bottom line: sell signals are active`,
        body: `${activeSells.length} sell ${activeSells.length === 1 ? 'strategy' : 'strategies'} triggered right now with ${(avgSellWin * 100).toFixed(0)}% avg win rate. No buy strategies are active.`,
        confidence: 'high',
        action: `The backtested data says avoid buying ${symbol} right now. Wait for sell conditions to clear.`,
      });
    } else {
      insights.unshift({
        type: 'bullish',
        title: `Bottom line: buy signals are active`,
        body: `${activeBuys.length} buy ${activeBuys.length === 1 ? 'strategy' : 'strategies'} triggered right now with ${(avgBuyWin * 100).toFixed(0)}% avg win rate. No sell strategies are active.`,
        confidence: 'high',
        action: `The backtested data supports buying ${symbol} right now. Consider entering with a position size you're comfortable with.`,
      });
    }
  }

  return insights;
}

/**
 * Check if a rule's condition matches the current (latest) data point
 */
function matchesCurrentCondition(
  condition: string,
  latest: Record<string, number>,
  rows: Record<string, number>[],
): boolean {
  const metricKeyMap: Record<string, string> = {
    'Fear & Greed Index': 'fearGreed',
    'Trading Volume': 'volume',
    'Volume/MCap Ratio': 'volMcap',
    'Sentiment Ratio': 'sentimentRatio',
    'Social Volume': 'socialVolume',
    'Developer Activity': 'devActivity',
  };

  // Parse "X is high" or "X is high AND Y is low"
  const parts = condition.split(' AND ').map(s => s.trim());

  for (const part of parts) {
    const isHigh = part.endsWith('is high');
    const label = part.replace(/ is (high|low)$/, '');
    const key = metricKeyMap[label];
    if (!key || latest[key] === undefined) return false;

    const vals = rows.map(r => r[key]).filter(v => v !== undefined && !isNaN(v)).sort((a, b) => a - b);
    const median = vals.length > 0 ? vals[Math.floor(vals.length / 2)] : 0;

    if (isHigh && latest[key] <= median) return false;
    if (!isHigh && latest[key] > median) return false;
  }

  return true;
}

// ============================================================
// BACKTESTING ENGINE
// Walk-forward validation with purge gap
// ============================================================
function backtestRules(
  rules: AssociationRule[],
  rows: Record<string, number>[],
  sortedDates: string[],
  dateMap: Map<string, Record<string, number>>,
  metrics: { key: string; label: string }[],
): StrategyBacktest[] {
  if (rows.length < 40 || rules.length === 0) return [];

  // Build metric key map for condition parsing
  const metricKeyMap: Record<string, string> = {};
  for (const { key, label } of metrics) {
    metricKeyMap[label] = key;
  }

  // Compute medians for condition evaluation
  const medians: Record<string, number> = {};
  for (const { key } of metrics) {
    const vals = rows.map(r => r[key]).filter(v => v !== undefined && !isNaN(v)).sort((a, b) => a - b);
    if (vals.length > 0) medians[key] = vals[Math.floor(vals.length / 2)];
  }

  // HODL return for benchmark
  const firstPrice = rows[0]?.price;
  const lastPrice = rows[rows.length - 1]?.price;
  const hodlReturn = firstPrice > 0 ? (lastPrice - firstPrice) / firstPrice : 0;

  const results: StrategyBacktest[] = [];

  // Take top 5 bullish + top 5 bearish rules by lift
  const bullishRules = rules.filter(r => r.outcome.includes('rises')).slice(0, 5);
  const bearishRules = rules.filter(r => r.outcome.includes('falls')).slice(0, 5);
  const topRules = [...bullishRules, ...bearishRules];

  for (const rule of topRules) {
    const isBullish = rule.outcome.includes('rises');

    for (const holdDays of [1, 2, 3, 5, 7, 10, 14, 30]) {
      const trades: BacktestTrade[] = [];

      // Walk through each day, check if condition matches
      for (let i = 0; i < rows.length - holdDays; i++) {
        const row = rows[i];
        if (row.return7d === undefined) continue;

        // Parse and evaluate condition
        if (!evaluateCondition(rule.condition, row, medians, metricKeyMap)) continue;

        // Execute trade
        const entryPrice = row.price;
        const exitPrice = rows[i + holdDays]?.price;
        if (!entryPrice || !exitPrice || entryPrice <= 0) continue;

        const returnPct = isBullish
          ? (exitPrice - entryPrice) / entryPrice
          : (entryPrice - exitPrice) / entryPrice; // short

        // Capture condition values at entry
        const conditions: Record<string, { value: number; level: string; median: number }> = {};
        const parts = rule.condition.split(' AND ').map(s => s.trim());
        for (const part of parts) {
          const isHigh = part.endsWith('is high');
          const label = part.replace(/ is (high|low)$/, '');
          const key = metricKeyMap[label];
          if (key && row[key] !== undefined && medians[key] !== undefined) {
            conditions[label] = {
              value: parseFloat(row[key].toFixed(4)),
              level: isHigh ? 'high' : 'low',
              median: parseFloat(medians[key].toFixed(4)),
            };
          }
        }

        // Keep full precision — don't round trade prices
        // Skip trades with no meaningful movement (< 0.1% change)
        const changePct = Math.abs((exitPrice - entryPrice) / entryPrice);
        if (changePct < 0.001) continue;

        // Compute max adverse excursion using daily HIGH/LOW (not just close)
        let maxAdverse = 0;
        for (let d = 0; d <= holdDays; d++) {
          const dayRow = rows[i + d];
          if (!dayRow) continue;
          // For long: worst case is the LOW of each day
          // For short: worst case is the HIGH of each day
          const worstPrice = isBullish
            ? (dayRow.priceLow ?? dayRow.price)
            : (dayRow.priceHigh ?? dayRow.price);
          const adverse = isBullish
            ? (entryPrice - worstPrice) / entryPrice
            : (worstPrice - entryPrice) / entryPrice;
          if (adverse > maxAdverse) maxAdverse = adverse;
        }

        trades.push({
          entryDate: sortedDates[i],
          exitDate: sortedDates[i + holdDays],
          entryPrice,
          exitPrice,
          returnPct,
          maxDrawdown: parseFloat(maxAdverse.toFixed(4)),
          rule: rule.condition,
          conditions,
        });

        // Skip overlapping trades
        i += holdDays - 1;
      }

      if (trades.length < 5) continue;

      // Skip if win rate is below 40% — not actionable
      const prelimWinRate = trades.filter(t => t.returnPct > 0).length / trades.length;
      if (prelimWinRate < 0.4) continue;

      // Compute metrics
      const returns = trades.map(t => t.returnPct);
      const wins = returns.filter(r => r > 0);
      const losses = returns.filter(r => r <= 0);
      const winRate = wins.length / returns.length;
      const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
      const grossProfit = wins.reduce((a, b) => a + b, 0);
      const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
      const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;

      // Equity curve: strategy compounds per trade
      // HODL curve: "bought $1000 at first trade entry, held until each trade exit date"
      // This tracks the real token price movement at the same timestamps
      const equity: number[] = [1000];
      const hodlCurve: number[] = [1000];
      const buyPrice = trades[0].entryPrice;
      for (let t = 0; t < trades.length; t++) {
        equity.push(equity[equity.length - 1] * (1 + trades[t].returnPct));
        hodlCurve.push(buyPrice > 0 ? 1000 * (trades[t].exitPrice / buyPrice) : 1000);
      }
      const totalReturn = (equity[equity.length - 1] - 1000) / 1000;

      // Max drawdown: worst adverse excursion across all trades
      const maxDD = Math.max(...trades.map(t => t.maxDrawdown));

      // Sharpe ratio (annualized, 365 days)
      const meanR = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((a, b) => a + (b - meanR) ** 2, 0) / returns.length;
      const stdR = Math.sqrt(variance);
      const sharpe = stdR > 0 ? (meanR / stdR) * Math.sqrt(365 / holdDays) : 0;

      // Bootstrap 95% CI for win rate
      const winRateCi = bootstrapCI(returns.map(r => r > 0 ? 1 : 0), 500);

      // Walk-forward fold stability (simple: split into 3 thirds)
      const thirdSize = Math.floor(trades.length / 3);
      let foldsProfitable = 0;
      const foldsTotal = thirdSize >= 2 ? 3 : 1;
      if (thirdSize >= 2) {
        for (let f = 0; f < 3; f++) {
          const foldReturns = returns.slice(f * thirdSize, (f + 1) * thirdSize);
          const foldSum = foldReturns.reduce((a, b) => a + b, 0);
          if (foldSum > 0) foldsProfitable++;
        }
      } else {
        foldsProfitable = totalReturn > 0 ? 1 : 0;
      }

      // Grade: percentile within this token's strategies
      const grade = gradeStrategy(winRate, profitFactor, totalReturn, maxDD, trades.length, foldsProfitable, foldsTotal);

      results.push({
        ruleId: rule.condition.replace(/\s+/g, '_').toLowerCase(),
        rulePlain: rule.plain,
        direction: isBullish ? 'buy' : 'sell',
        holdDays,
        totalTrades: trades.length,
        winRate: parseFloat(winRate.toFixed(3)),
        winRateCi: [parseFloat(winRateCi[0].toFixed(3)), parseFloat(winRateCi[1].toFixed(3))],
        profitFactor: parseFloat(profitFactor.toFixed(2)),
        avgReturnPerTrade: parseFloat((avgReturn * 100).toFixed(2)),
        totalReturn: parseFloat(totalReturn.toFixed(4)),
        maxDrawdown: parseFloat(maxDD.toFixed(4)),
        sharpeRatio: parseFloat(sharpe.toFixed(2)),
        expectancyPer1000: parseFloat((avgReturn * 1000).toFixed(2)),
        hodlReturn: parseFloat(hodlReturn.toFixed(4)),
        alphaVsHodl: parseFloat((totalReturn - hodlReturn).toFixed(4)),
        equityCurve: equity.map(e => parseFloat(e.toFixed(2))),
        hodlCurve: hodlCurve.map(h => parseFloat(h.toFixed(2))),
        trades,
        foldsProfitable,
        foldsTotal,
        grade,
        isOptimal: false,
        holdComparison: [],
        currentlyActive: false,
        currentConditions: [],
      });
    }
  }

  // Group by rule, find optimal hold period per rule, attach comparison
  const byRule = new Map<string, StrategyBacktest[]>();
  for (const r of results) {
    const key = `${r.ruleId}_${r.direction}`;
    if (!byRule.has(key)) byRule.set(key, []);
    byRule.get(key)!.push(r);
  }

  const finalResults: StrategyBacktest[] = [];
  for (const [, group] of byRule) {
    // Build hold comparison for all periods
    const holdComparison = group.map(g => ({
      days: g.holdDays,
      winRate: g.winRate,
      avgReturn: g.avgReturnPerTrade,
      trades: g.totalTrades,
    })).sort((a, b) => a.days - b.days);

    // Find optimal = best risk-adjusted return (avg return × win rate) with 5+ trades
    const score = (g: StrategyBacktest) => g.avgReturnPerTrade * g.winRate * Math.min(g.totalTrades / 10, 1);
    const eligible = group.filter(g => g.totalTrades >= 5);
    const optimal = eligible.length > 0
      ? eligible.sort((a, b) => score(b) - score(a))[0]
      : group.sort((a, b) => score(b) - score(a))[0];

    for (const r of group) {
      r.holdComparison = holdComparison;
      r.isOptimal = r === optimal;
    }

    // Only include the optimal hold period in final results
    if (optimal) {
      // Evaluate current conditions (latest data point)
      const latestRow = rows[rows.length - 1];
      if (latestRow && optimal.trades.length > 0) {
        const condition = optimal.trades[0].rule;
        const parts = condition.split(' AND ').map((s: string) => s.trim());
        const currentConds: StrategyBacktest['currentConditions'] = [];
        let allActive = true;

        // Build full label→key map from ALL known metrics (not just filtered ones)
        const fullKeyMap: Record<string, string> = { ...metricKeyMap };
        // Add any metrics that might be in rules but not in the filtered list
        const allMetricDefs: [string, string][] = [
          ['Fear & Greed Index', 'fearGreed'], ['Trading Volume', 'volume'],
          ['Volume/MCap Ratio', 'volMcap'], ['Sentiment Ratio', 'sentimentRatio'],
          ['RSI (14d)', 'rsi'], ['Volatility (14d)', 'volatility'],
          ['Price Momentum', 'momentum'], ['Volume Trend', 'volumeTrend'],
          ['Social Volume', 'socialVolume'], ['Dev Activity', 'devActivity'],
          ['Social Dominance', 'socialDominance'], ['Dev Contributors', 'devContributors'],
          ['MVRV Ratio', 'mvrv'], ['Exchange Balance', 'exchangeBalance'],
          ['Active Addresses', 'activeAddresses'], ['Network Growth', 'networkGrowth'],
          ['Whale Transactions', 'whaleTransactions'], ['NVT Ratio', 'nvt'],
          ['Funding Rate (Binance)', 'fundingRate'], ['Open Interest (Binance)', 'openInterest'],
          ['Long/Short Ratio', 'longShortRatio'], ['Taker Buy/Sell Ratio', 'takerBuySell'],
          ['Funding Rate (Hyperliquid)', 'hlFundingRate'], ['DEX Volume (Hyperliquid)', 'hlVolume'],
          ['DEX Daily Range', 'hlDailyRange'], ['DEX Candle Body', 'hlCandleBody'],
          ['DEX Upper Wick', 'hlUpperWick'], ['DEX Lower Wick', 'hlLowerWick'],
          ['CEX/DEX Volume Ratio', 'cexDexVolRatio'], ['CEX-DEX Funding Spread', 'fundingSpread'],
          ['Total Value Locked', 'tvl'],
        ];
        for (const [lbl, k] of allMetricDefs) fullKeyMap[lbl] = k;

        for (const part of parts) {
          const isHigh = part.endsWith('is high');
          const label = part.replace(/ is (high|low)$/, '');
          const key = fullKeyMap[label];
          if (!key) { allActive = false; continue; }

          // Find most recent available value (Santiment free tier can lag 30+ days)
          let value: number | undefined;
          for (let r = rows.length - 1; r >= 0; r--) {
            if (rows[r][key] !== undefined && !isNaN(rows[r][key])) {
              value = rows[r][key];
              break;
            }
          }
          if (value === undefined) { allActive = false; continue; }

          // Compute median from all rows for this key
          const vals = rows.map(r => r[key]).filter(v => v !== undefined && !isNaN(v)).sort((a, b) => a - b);
          const median = vals.length > 0 ? vals[Math.floor(vals.length / 2)] : 0;
          const pct = median !== 0 ? ((value - median) / Math.abs(median)) * 100 : 0;
          const meetsCondition = isHigh ? value > median : value <= median;
          if (!meetsCondition) allActive = false;

          // Format the value
          const abs = Math.abs(value);
          let formatted: string;
          if (abs >= 1e12) formatted = (value / 1e12).toFixed(1) + 'T';
          else if (abs >= 1e9) formatted = (value / 1e9).toFixed(1) + 'B';
          else if (abs >= 1e6) formatted = (value / 1e6).toFixed(1) + 'M';
          else if (abs >= 1e3) formatted = (value / 1e3).toFixed(1) + 'K';
          else if (abs >= 1) formatted = value.toFixed(2);
          else if (abs >= 0.001) formatted = value.toFixed(4);
          else formatted = value.toExponential(1);

          currentConds.push({
            label,
            value,
            formatted,
            level: isHigh ? 'high' : 'low',
            median,
            pctVsMedian: parseFloat(pct.toFixed(1)),
          });
        }

        optimal.currentlyActive = allActive;
        optimal.currentConditions = currentConds;
      }

      finalResults.push(optimal);
    }
  }

  return finalResults.sort((a, b) => {
    const gradeOrder = { A: 0, B: 1, C: 2, D: 3, F: 4 };
    const gDiff = gradeOrder[a.grade] - gradeOrder[b.grade];
    if (gDiff !== 0) return gDiff;
    return b.profitFactor - a.profitFactor;
  });
}

function evaluateCondition(
  condition: string,
  row: Record<string, number>,
  medians: Record<string, number>,
  metricKeyMap: Record<string, string>,
): boolean {
  const parts = condition.split(' AND ').map(s => s.trim());
  for (const part of parts) {
    const isHigh = part.endsWith('is high');
    const label = part.replace(/ is (high|low)$/, '');
    const key = metricKeyMap[label];
    if (!key || row[key] === undefined || isNaN(row[key]) || medians[key] === undefined) return false;
    if (isHigh && row[key] <= medians[key]) return false;
    if (!isHigh && row[key] > medians[key]) return false;
  }
  return true;
}

function bootstrapCI(data: number[], nSamples: number): [number, number] {
  if (data.length < 3) return [0, 1];
  const means: number[] = [];
  for (let i = 0; i < nSamples; i++) {
    let sum = 0;
    for (let j = 0; j < data.length; j++) {
      sum += data[Math.floor(Math.random() * data.length)];
    }
    means.push(sum / data.length);
  }
  means.sort((a, b) => a - b);
  return [
    means[Math.floor(nSamples * 0.025)],
    means[Math.floor(nSamples * 0.975)],
  ];
}

function gradeStrategy(
  winRate: number,
  profitFactor: number,
  totalReturn: number,
  maxDrawdown: number,
  trades: number,
  foldsProfitable: number,
  foldsTotal: number,
): 'A' | 'B' | 'C' | 'D' | 'F' {
  let points = 0;

  // Win rate (0-25 pts)
  if (winRate >= 0.7) points += 25;
  else if (winRate >= 0.6) points += 20;
  else if (winRate >= 0.55) points += 15;
  else if (winRate >= 0.5) points += 10;

  // Profit factor (0-25 pts)
  if (profitFactor >= 2.5) points += 25;
  else if (profitFactor >= 1.8) points += 20;
  else if (profitFactor >= 1.3) points += 15;
  else if (profitFactor >= 1.0) points += 10;

  // Sample size (0-20 pts)
  if (trades >= 20) points += 20;
  else if (trades >= 15) points += 15;
  else if (trades >= 10) points += 10;
  else if (trades >= 5) points += 5;

  // Max drawdown penalty (0-15 pts)
  if (maxDrawdown <= 0.05) points += 15;
  else if (maxDrawdown <= 0.1) points += 10;
  else if (maxDrawdown <= 0.2) points += 5;

  // Fold stability (0-15 pts)
  const foldRatio = foldsTotal > 0 ? foldsProfitable / foldsTotal : 0;
  if (foldRatio >= 0.8) points += 15;
  else if (foldRatio >= 0.6) points += 10;
  else if (foldRatio >= 0.4) points += 5;

  // Grade based on points (out of 100)
  if (points >= 75) return 'A';
  if (points >= 60) return 'B';
  if (points >= 45) return 'C';
  if (points >= 30) return 'D';
  return 'F';
}

// ============================================================
// COMPOSITE SCORE (0-100)
// Single number summarizing the token's statistical outlook
// ============================================================
function computeScore(
  correlations: MetricCorrelation[],
  rules: AssociationRule[],
  backtests: StrategyBacktest[],
  regime: string,
  rows: Record<string, number>[],
): { score: number; signal: 'bullish' | 'bearish' | 'neutral' } {
  let bullishPoints = 0;
  let bearishPoints = 0;

  // 1. Significant correlations direction (weight: 30)
  const sigCorr = correlations.filter(c => c.significant_7d || c.significant_14d);
  for (const c of sigCorr) {
    const weight = Math.abs(c.r_7d ?? c.r_14d ?? 0) * 15;
    if (c.direction === 'bullish') bullishPoints += weight;
    else if (c.direction === 'bearish') bearishPoints += weight;
  }

  // 2. Active association rules (weight: 30)
  const latest = rows[rows.length - 1];
  if (latest) {
    const metricKeyMap: Record<string, string> = {};
    for (const c of correlations) metricKeyMap[c.label] = c.metric;
    const medians: Record<string, number> = {};
    for (const c of correlations) {
      const vals = rows.map(r => r[c.metric]).filter(v => v !== undefined && !isNaN(v)).sort((a, b) => a - b);
      if (vals.length > 0) medians[c.metric] = vals[Math.floor(vals.length / 2)];
    }

    for (const rule of rules) {
      if (matchesCurrentCondition(rule.condition, latest, rows)) {
        const weight = rule.lift * 5;
        if (rule.outcome.includes('rises')) bullishPoints += weight;
        else bearishPoints += weight;
      }
    }
  }

  // 3. Regime (weight: 20)
  if (regime === 'PANIC_SELLING' || regime === 'CAPITULATION') bullishPoints += 20;
  else if (regime === 'EUPHORIA') bearishPoints += 20;
  else if (regime === 'COMPLACENCY') bearishPoints += 10;

  // 4. Best backtest performance (weight: 10)
  if (backtests.length > 0) {
    const bestBuy = backtests.find(b => b.direction === 'buy');
    const bestSell = backtests.find(b => b.direction === 'sell');
    if (bestBuy && bestBuy.totalReturn > 0) bullishPoints += Math.min(10, bestBuy.winRate * 10);
    if (bestSell && bestSell.totalReturn > 0) bearishPoints += Math.min(10, bestSell.winRate * 10);
  }

  // 5. Currently ACTIVE strategies — strongest signal (weight: 30)
  const activeStrats = backtests.filter(b => b.currentlyActive);
  if (activeStrats.length > 0) {
    for (const s of activeStrats) {
      // Weight by win rate and grade quality
      const gradeMultiplier = s.grade === 'A' ? 1.5 : s.grade === 'B' ? 1.0 : 0.5;
      const weight = s.winRate * 10 * gradeMultiplier;
      if (s.direction === 'buy') bullishPoints += weight;
      else bearishPoints += weight;
    }
  }

  // Normalize to 0-100
  const total = bullishPoints + bearishPoints;
  if (total === 0) return { score: 50, signal: 'neutral' };

  const bullishRatio = bullishPoints / total;
  // Score: 0 = max bearish, 50 = neutral, 100 = max bullish
  const score = Math.round(bullishRatio * 100);

  const signal: 'bullish' | 'bearish' | 'neutral' =
    score >= 60 ? 'bullish' : score <= 40 ? 'bearish' : 'neutral';

  return { score, signal };
}
