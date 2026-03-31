/**
 * On-chain transfer processor.
 *
 * Takes raw ERC20 transfer data from Etherscan and produces:
 *   - 10 daily time series (profiler-ready { date, value }[])
 *   - 5 event signals (alerts for unusual activity)
 *
 * Single pass over transfers → O(n) for most metrics.
 */

import { EXCHANGE_SET, EXCHANGE_ADDRESSES, BURN_ADDRESSES } from './exchangeAddresses.js';

// ─── Types ───────────────────────────────────────────────────

export interface RawTransfer {
  timeStamp: string;  // unix seconds
  from: string;
  to: string;
  value: string;      // raw integer string
  hash: string;
  tokenDecimal?: string;
}

export interface DailyMetrics {
  // Profiler-ready time series
  supplyInMotion:       { date: string; value: number }[];
  tokenVelocity:        { date: string; value: number }[];
  senderReceiverRatio:  { date: string; value: number }[];
  avgTransferSize:      { date: string; value: number }[];
  retailRatio:          { date: string; value: number }[];
  exchangeNetFlow:      { date: string; value: number }[];
  washTradingPct:       { date: string; value: number }[];
  newAddressPct:        { date: string; value: number }[];
  onchainTxCount:       { date: string; value: number }[];
  onchainActiveAddrs:   { date: string; value: number }[];
}

export interface EventSignals {
  exchangeFlowSpike:  { detected: boolean; date: string; magnitude: number; direction: 'inflow' | 'outflow'; exchange?: string } | null;
  anomalies:          { metric: string; date: string; zScore: number; value: number; avg: number }[];
  washTradingSurge:   { detected: boolean; date: string; pct: number } | null;
  vestingCandidates:  { from: string; value: number; occurrences: number; interval: string }[];
  burnSpike:          { detected: boolean; date: string; amount: number; avgDaily: number } | null;
}

export interface ProcessedOnchain {
  metrics: DailyMetrics;
  events: EventSignals;
  summary: {
    totalTransfers: number;
    daysOfData: number;
    dateRange: { from: string; to: string };
    chainsWithData: number;
  };
}

// ─── Internal bucket ─────────────────────────────────────────

interface DayBucket {
  txCount: number;
  senders: Set<string>;
  receivers: Set<string>;
  allAddrs: Set<string>;
  totalVolume: number;
  values: number[];
  exchangeInflow: number;   // volume TO exchanges
  exchangeOutflow: number;  // volume FROM exchanges
  exchangeInCount: number;
  exchangeOutCount: number;
  burnVolume: number;
  // Wash detection: track (from→to) pairs
  pairCounts: Map<string, number>;
  pairVolume: Map<string, number>;
  // Retail vs institutional buckets
  retailTxs: number;  // < 1000 tokens
  instTxs: number;    // >= 1000 tokens
}

function emptyBucket(): DayBucket {
  return {
    txCount: 0, senders: new Set(), receivers: new Set(), allAddrs: new Set(),
    totalVolume: 0, values: [], exchangeInflow: 0, exchangeOutflow: 0,
    exchangeInCount: 0, exchangeOutCount: 0, burnVolume: 0,
    pairCounts: new Map(), pairVolume: new Map(), retailTxs: 0, instTxs: 0,
  };
}

// ─── Main processor ──────────────────────────────────────────

export function processTransfers(
  transfers: RawTransfer[],
  circulatingSupply: number,
  decimals: number = 18,
): ProcessedOnchain {
  const divisor = Math.pow(10, Math.min(decimals, 18));

  // ── Pass 1: Bucket by day ──
  const byDate: Record<string, DayBucket> = {};

  for (const tx of transfers) {
    const date = new Date(parseInt(tx.timeStamp) * 1000).toISOString().split('T')[0];
    const value = parseFloat(tx.value) / divisor;
    const from = tx.from.toLowerCase();
    const to = tx.to.toLowerCase();

    if (!byDate[date]) byDate[date] = emptyBucket();
    const d = byDate[date];

    d.txCount++;
    d.senders.add(from);
    d.receivers.add(to);
    d.allAddrs.add(from);
    d.allAddrs.add(to);
    d.totalVolume += value;
    d.values.push(value);

    // Exchange flow
    if (EXCHANGE_SET.has(to)) {
      d.exchangeInflow += value;
      d.exchangeInCount++;
    }
    if (EXCHANGE_SET.has(from)) {
      d.exchangeOutflow += value;
      d.exchangeOutCount++;
    }

    // Burns
    if (BURN_ADDRESSES.has(to)) {
      d.burnVolume += value;
    }

    // Wash detection: track pairs
    const pairKey = `${from}:${to}`;
    d.pairCounts.set(pairKey, (d.pairCounts.get(pairKey) || 0) + 1);
    d.pairVolume.set(pairKey, (d.pairVolume.get(pairKey) || 0) + value);

    // Retail vs institutional
    if (value < 1000) d.retailTxs++;
    else d.instTxs++;
  }

  const dates = Object.keys(byDate).sort();
  if (dates.length === 0) {
    return {
      metrics: {
        supplyInMotion: [], tokenVelocity: [], senderReceiverRatio: [],
        avgTransferSize: [], retailRatio: [], exchangeNetFlow: [],
        washTradingPct: [], newAddressPct: [], onchainTxCount: [], onchainActiveAddrs: [],
      },
      events: { exchangeFlowSpike: null, anomalies: [], washTradingSurge: null, vestingCandidates: [], burnSpike: null },
      summary: { totalTransfers: 0, daysOfData: 0, dateRange: { from: '', to: '' }, chainsWithData: 0 },
    };
  }

  // ── Pass 2: Compute daily metrics ──

  const seenBefore = new Set<string>();
  const metrics: DailyMetrics = {
    supplyInMotion: [],
    tokenVelocity: [],
    senderReceiverRatio: [],
    avgTransferSize: [],
    retailRatio: [],
    exchangeNetFlow: [],
    washTradingPct: [],
    newAddressPct: [],
    onchainTxCount: [],
    onchainActiveAddrs: [],
  };

  for (const date of dates) {
    const d = byDate[date];
    const supply = circulatingSupply || 1;

    // 1. Supply in motion: % of circulating supply transferred today
    metrics.supplyInMotion.push({ date, value: parseFloat((d.totalVolume / supply * 100).toFixed(4)) });

    // 2. Token velocity: volume / supply (annualized would be * 365, but daily is better for profiler)
    metrics.tokenVelocity.push({ date, value: parseFloat((d.totalVolume / supply).toFixed(6)) });

    // 3. Sender/receiver ratio: >1 = accumulation, <1 = distribution
    const ratio = d.senders.size > 0 ? d.receivers.size / d.senders.size : 1;
    metrics.senderReceiverRatio.push({ date, value: parseFloat(ratio.toFixed(4)) });

    // 4. Average transfer size
    const avg = d.txCount > 0 ? d.totalVolume / d.txCount : 0;
    metrics.avgTransferSize.push({ date, value: parseFloat(avg.toFixed(2)) });

    // 5. Retail ratio: % of transactions < 1000 tokens
    const retailPct = d.txCount > 0 ? d.retailTxs / d.txCount : 0;
    metrics.retailRatio.push({ date, value: parseFloat(retailPct.toFixed(4)) });

    // 6. Exchange net flow: positive = outflow (bullish), negative = inflow (bearish)
    const netFlow = d.exchangeOutflow - d.exchangeInflow;
    metrics.exchangeNetFlow.push({ date, value: parseFloat(netFlow.toFixed(2)) });

    // 7. Wash trading %: volume in round-trip pairs / total volume
    let washVolume = 0;
    for (const [pair, count] of d.pairCounts.entries()) {
      if (count <= 1) continue;
      const [from, to] = pair.split(':');
      const reversePair = `${to}:${from}`;
      if (d.pairCounts.has(reversePair)) {
        // Both A→B and B→A exist on same day
        washVolume += d.pairVolume.get(pair) || 0;
      }
    }
    const washPct = d.totalVolume > 0 ? washVolume / d.totalVolume : 0;
    metrics.washTradingPct.push({ date, value: parseFloat(washPct.toFixed(4)) });

    // 8. New address %: addresses not seen in any previous day
    const newAddrs = [...d.allAddrs].filter(a => !seenBefore.has(a));
    const newPct = d.allAddrs.size > 0 ? newAddrs.length / d.allAddrs.size : 0;
    metrics.newAddressPct.push({ date, value: parseFloat(newPct.toFixed(4)) });
    for (const a of d.allAddrs) seenBefore.add(a);

    // 9. Raw tx count
    metrics.onchainTxCount.push({ date, value: d.txCount });

    // 10. Active addresses
    metrics.onchainActiveAddrs.push({ date, value: d.allAddrs.size });
  }

  // ── Pass 3: Event signals ──

  const events: EventSignals = {
    exchangeFlowSpike: null,
    anomalies: [],
    washTradingSurge: null,
    vestingCandidates: [],
    burnSpike: null,
  };

  // Exchange flow spike: last day's net flow vs 30d average
  if (dates.length >= 7) {
    const flowValues = metrics.exchangeNetFlow.map(p => p.value);
    const recent = flowValues.slice(-7);
    const older = flowValues.slice(0, -7);
    if (older.length >= 7) {
      const avgOlder = older.reduce((a, b) => a + b, 0) / older.length;
      const stdOlder = Math.sqrt(older.reduce((a, b) => a + (b - avgOlder) ** 2, 0) / older.length) || 1;
      const lastDay = flowValues[flowValues.length - 1];
      const zScore = (lastDay - avgOlder) / stdOlder;
      if (Math.abs(zScore) > 2.5) {
        events.exchangeFlowSpike = {
          detected: true,
          date: dates[dates.length - 1],
          magnitude: parseFloat(zScore.toFixed(2)),
          direction: lastDay < 0 ? 'inflow' : 'outflow',
        };
      }
    }
  }

  // Anomaly detection: z-score > 2.5 on any metric in the last day
  if (dates.length >= 30) {
    const metricEntries: [string, { date: string; value: number }[]][] = [
      ['txCount', metrics.onchainTxCount],
      ['activeAddresses', metrics.onchainActiveAddrs],
      ['supplyInMotion', metrics.supplyInMotion],
      ['avgTransferSize', metrics.avgTransferSize],
    ];
    for (const [name, series] of metricEntries) {
      const vals = series.map(p => p.value);
      const window = vals.slice(-31, -1); // last 30d excluding today
      const today = vals[vals.length - 1];
      const avg = window.reduce((a, b) => a + b, 0) / window.length;
      const std = Math.sqrt(window.reduce((a, b) => a + (b - avg) ** 2, 0) / window.length) || 1;
      const z = (today - avg) / std;
      if (Math.abs(z) > 2.5) {
        events.anomalies.push({
          metric: name,
          date: dates[dates.length - 1],
          zScore: parseFloat(z.toFixed(2)),
          value: today,
          avg: parseFloat(avg.toFixed(2)),
        });
      }
    }
  }

  // Wash trading surge: latest day wash % > 30%
  if (metrics.washTradingPct.length > 0) {
    const latest = metrics.washTradingPct[metrics.washTradingPct.length - 1];
    if (latest.value > 0.3) {
      events.washTradingSurge = {
        detected: true,
        date: latest.date,
        pct: parseFloat((latest.value * 100).toFixed(1)),
      };
    }
  }

  // Vesting detection: same (from, rounded_value) appearing 3+ times at regular intervals
  const vestingMap = new Map<string, { dates: string[]; value: number; from: string }>();
  for (const tx of transfers) {
    const value = parseFloat(tx.value) / divisor;
    if (value < 100) continue; // skip dust
    const roundedVal = Math.round(value);
    const key = `${tx.from.toLowerCase().slice(0, 12)}:${roundedVal}`;
    if (!vestingMap.has(key)) {
      vestingMap.set(key, { dates: [], value: roundedVal, from: tx.from.toLowerCase() });
    }
    const date = new Date(parseInt(tx.timeStamp) * 1000).toISOString().split('T')[0];
    const entry = vestingMap.get(key)!;
    if (!entry.dates.includes(date)) entry.dates.push(date);
  }
  for (const [, v] of vestingMap) {
    if (v.dates.length >= 3) {
      // Check regularity: compute intervals between dates
      const sorted = v.dates.sort();
      const intervals: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const diff = (new Date(sorted[i]).getTime() - new Date(sorted[i - 1]).getTime()) / 86400000;
        intervals.push(diff);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const stdInterval = Math.sqrt(intervals.reduce((a, b) => a + (b - avgInterval) ** 2, 0) / intervals.length);
      // Regular if std < 30% of avg (roughly periodic)
      if (avgInterval > 3 && stdInterval / avgInterval < 0.3) {
        let intervalLabel = `~${Math.round(avgInterval)}d`;
        if (Math.abs(avgInterval - 7) < 2) intervalLabel = 'weekly';
        if (Math.abs(avgInterval - 14) < 3) intervalLabel = 'biweekly';
        if (Math.abs(avgInterval - 30) < 5) intervalLabel = 'monthly';

        events.vestingCandidates.push({
          from: v.from.slice(0, 10) + '...' + v.from.slice(-4),
          value: v.value,
          occurrences: v.dates.length,
          interval: intervalLabel,
        });
      }
    }
  }
  events.vestingCandidates.sort((a, b) => b.value * b.occurrences - a.value * a.occurrences);
  events.vestingCandidates = events.vestingCandidates.slice(0, 5);

  // Burn spike: latest day burns > 3x daily average
  if (dates.length >= 7) {
    const dailyBurns = dates.map(d => byDate[d].burnVolume);
    const avgBurn = dailyBurns.reduce((a, b) => a + b, 0) / dailyBurns.length;
    const latestBurn = dailyBurns[dailyBurns.length - 1];
    if (latestBurn > avgBurn * 3 && latestBurn > 0) {
      events.burnSpike = {
        detected: true,
        date: dates[dates.length - 1],
        amount: parseFloat(latestBurn.toFixed(2)),
        avgDaily: parseFloat(avgBurn.toFixed(2)),
      };
    }
  }

  return {
    metrics,
    events,
    summary: {
      totalTransfers: transfers.length,
      daysOfData: dates.length,
      dateRange: { from: dates[0], to: dates[dates.length - 1] },
      chainsWithData: 0, // set by caller
    },
  };
}
