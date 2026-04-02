import { Hono } from 'hono';
import { getCoinDetail } from '../lib/coingecko.js';
import { processTransfers, type RawTransfer, type DailyMetrics } from '../lib/onchainProcessor.js';
import { onchainCache, onchainProgress } from '../lib/onchainCache.js';

export const onchainRoute = new Hono();

const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || '';
const PAGE_SIZE = 10000;

interface ChainConfig {
  chainId: number;
  name: string;
  source: 'etherscan' | 'custom';
  customApi?: string;
}

const CHAINS: Record<string, ChainConfig> = {
  ethereum:               { chainId: 1,     name: 'Ethereum',  source: 'etherscan' },
  'polygon-pos':          { chainId: 137,   name: 'Polygon',   source: 'etherscan' },
  'arbitrum-one':         { chainId: 42161, name: 'Arbitrum',  source: 'etherscan' },
  base:                   { chainId: 8453,  name: 'Base',      source: 'custom', customApi: 'https://base.blockscout.com/api' },
  'optimistic-ethereum':  { chainId: 10,    name: 'Optimism',  source: 'custom', customApi: 'https://api.routescan.io/v2/network/mainnet/evm/10/etherscan/api' },
  avalanche:              { chainId: 43114, name: 'Avalanche', source: 'custom', customApi: 'https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api' },
  'binance-smart-chain':  { chainId: 56,    name: 'BSC',       source: 'custom', customApi: 'https://api.bscscan.com/api' },
};

async function fetchTokenTxs(
  chain: ChainConfig, contract: string, startTimestamp: number,
  onProgress?: (chunksDone: number, totalChunks: number, txsSoFar: number) => void,
): Promise<RawTransfer[]> {
  const allTxs: RawTransfer[] = [];

  if (chain.source === 'etherscan') {
    let startBlock = 0, endBlock = 0;
    try {
      const [startRes, endRes] = await Promise.all([
        fetch(`https://api.etherscan.io/v2/api?chainid=${chain.chainId}&module=block&action=getblocknobytime&timestamp=${startTimestamp}&closest=after&apikey=${ETHERSCAN_KEY}`, { signal: AbortSignal.timeout(10000) }),
        fetch(`https://api.etherscan.io/v2/api?chainid=${chain.chainId}&module=block&action=getblocknobytime&timestamp=${Math.floor(Date.now() / 1000)}&closest=before&apikey=${ETHERSCAN_KEY}`, { signal: AbortSignal.timeout(10000) }),
      ]);
      const startJson = await startRes.json();
      const endJson = await endRes.json();
      if (startJson.status === '1') startBlock = parseInt(startJson.result);
      if (endJson.status === '1') endBlock = parseInt(endJson.result);
    } catch { /* fallback below */ }

    if (endBlock > startBlock) {
      const totalBlocks = endBlock - startBlock;
      const NUM_CHUNKS = 15;
      const chunkSize = Math.ceil(totalBlocks / NUM_CHUNKS);
      onProgress?.(0, NUM_CHUNKS, 0);

      for (let i = 0; i < NUM_CHUNKS; i++) {
        const fromBlock = startBlock + (i * chunkSize);
        const toBlock = Math.min(fromBlock + chunkSize - 1, endBlock);
        try {
          const res = await fetch(
            `https://api.etherscan.io/v2/api?chainid=${chain.chainId}&module=account&action=tokentx` +
            `&contractaddress=${contract}&startblock=${fromBlock}&endblock=${toBlock}` +
            `&page=1&offset=${PAGE_SIZE}&sort=asc&apikey=${ETHERSCAN_KEY}`,
            { signal: AbortSignal.timeout(30000) }
          );
          const json = await res.json();
          if (json.status === '1' && Array.isArray(json.result)) {
            for (const tx of json.result) allTxs.push(tx);
          }
        } catch { /* skip chunk */ }
        onProgress?.(i + 1, NUM_CHUNKS, allTxs.length);
        await new Promise(r => setTimeout(r, 200));
      }
    }
  } else if (chain.customApi) {
    let startBlock = 0, endBlock = 0;
    try {
      const [startRes, endRes] = await Promise.all([
        fetch(`${chain.customApi}?module=block&action=getblocknobytime&timestamp=${startTimestamp}&closest=after`, { signal: AbortSignal.timeout(10000) }),
        fetch(`${chain.customApi}?module=block&action=getblocknobytime&timestamp=${Math.floor(Date.now() / 1000)}&closest=before`, { signal: AbortSignal.timeout(10000) }),
      ]);
      const startJson = await startRes.json();
      const endJson = await endRes.json();
      startBlock = parseInt(startJson.result?.blockNumber || startJson.result || '0');
      endBlock = parseInt(endJson.result?.blockNumber || endJson.result || '0');
    } catch { /* fall through */ }

    if (endBlock > startBlock) {
      const totalBlocks = endBlock - startBlock;
      const NUM_CHUNKS = 15;
      const chunkSize = Math.ceil(totalBlocks / NUM_CHUNKS);
      onProgress?.(0, NUM_CHUNKS, 0);

      for (let i = 0; i < NUM_CHUNKS; i++) {
        const fromBlock = startBlock + (i * chunkSize);
        const toBlock = Math.min(fromBlock + chunkSize - 1, endBlock);
        try {
          const res = await fetch(
            `${chain.customApi}?module=account&action=tokentx` +
            `&contractaddress=${contract}&startblock=${fromBlock}&endblock=${toBlock}` +
            `&page=1&offset=${PAGE_SIZE}&sort=asc`,
            { signal: AbortSignal.timeout(30000) }
          );
          const json = await res.json();
          if (json.status === '1' && Array.isArray(json.result)) {
            for (const tx of json.result) allTxs.push(tx);
          }
        } catch { /* skip chunk */ }
        onProgress?.(i + 1, NUM_CHUNKS, allTxs.length);
        await new Promise(r => setTimeout(r, 500));
      }
    } else {
      try {
        const res = await fetch(
          `${chain.customApi}?module=account&action=tokentx` +
          `&contractaddress=${contract}&page=1&offset=${PAGE_SIZE}&sort=desc`,
          { signal: AbortSignal.timeout(30000) }
        );
        const json = await res.json();
        if (json.status === '1' && Array.isArray(json.result)) {
          const filtered = json.result.filter((tx: any) => parseInt(tx.timeStamp) >= startTimestamp);
          allTxs.push(...filtered);
        }
      } catch { /* no data */ }
    }
  }

  return allTxs;
}

// Mock data generator for testing UI without hitting Etherscan
function generateMockResult(id: string) {
  const days = 30;
  const gen = (base: number) => {
    const arr: { date: string; value: number }[] = [];
    for (let i = days; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      arr.push({ date: d.toISOString().split('T')[0], value: base * (0.7 + Math.random() * 0.6) });
    }
    return arr;
  };
  const metrics: DailyMetrics = {
    supplyInMotion: gen(0.5), tokenVelocity: gen(0.5), senderReceiverRatio: gen(0.5),
    avgTransferSize: gen(5000), retailRatio: gen(0.5), exchangeNetFlow: gen(0.5),
    washTradingPct: gen(0.5), newAddressPct: gen(0.5), onchainTxCount: gen(500), onchainActiveAddrs: gen(200),
  };

  return {
    token: { id, name: id, symbol: id.toUpperCase(), decimals: 18, circulatingSupply: 1000000000 },
    chains: [
      { name: 'Ethereum', chainId: 1, contract: '0xmock', transfers: 8432 },
      { name: 'Polygon', chainId: 137, contract: '0xmock', transfers: 3201 },
    ],
    metrics,
    events: {
      exchangeFlowSpike: { detected: true, date: new Date().toISOString().split('T')[0], magnitude: 3.2, direction: 'outflow' as const },
      anomalies: [
        { metric: 'onchainTxCount', date: new Date().toISOString().split('T')[0], zScore: 2.8, value: 1200, avg: 500 },
      ],
      washTradingSurge: { detected: true, date: new Date().toISOString().split('T')[0], pct: 18 },
      vestingCandidates: [
        { from: '0x9270cc54...3299', value: 539, occurrences: 5, interval: 'biweekly' },
        { from: '0xdfd5293d...963d', value: 539, occurrences: 4, interval: 'biweekly' },
      ],
      burnSpike: null,
    },
    summary: {
      totalTransfers: 11633, daysOfData: days, chainsWithData: 2,
      dateRange: { from: new Date(Date.now() - days * 86400000).toISOString().split('T')[0], to: new Date().toISOString().split('T')[0] },
    },
  };
}

// Main route
onchainRoute.get('/', async (c) => {
  const id = c.req.query('id');
  if (!id) return c.json({ error: 'id required' }, 400);

  // Mock mode: ?mock=1 returns instant fake data
  if (c.req.query('mock') === '1') {
    const mock = generateMockResult(id);
    onchainCache.set(id, mock);
    return c.json({ message: 'SUCCESS', cached: false, ...mock });
  }

  // Mock loading mode: ?mock=loading simulates a slow scan with progress
  if (c.req.query('mock') === 'loading') {
    const noCache = c.req.query('nocache') === '1';
    if (!noCache) {
      const cached = onchainCache.get(id);
      if (cached) return c.json({ message: 'SUCCESS', cached: true, ...cached.data });
    }

    const existing = onchainProgress.get(id);
    if (existing && existing.status === 'fetching') {
      return c.json({ message: 'SUCCESS', status: 'fetching', cached: false, summary: { totalChains: existing.totalChains } });
    }

    // Start mock background scan
    onchainProgress.set(id, {
      status: 'fetching', totalChains: 2, completedChains: 0,
      currentChain: 'Ethereum', totalTransfers: 0, startedAt: Date.now(),
      currentChainChunks: 15, currentChainChunksDone: 0, currentChainTransfers: 0,
    });

    // Simulate progress over ~15 seconds
    (async () => {
      const prog = onchainProgress.get(id);
      if (!prog) return;
      for (let i = 1; i <= 15; i++) {
        await new Promise(r => setTimeout(r, 500));
        prog.currentChainChunksDone = i;
        prog.currentChainTransfers = i * 560;
      }
      prog.completedChains = 1;
      prog.currentChain = 'Polygon';
      prog.currentChainChunksDone = 0;
      prog.currentChainTransfers = 0;
      for (let i = 1; i <= 15; i++) {
        await new Promise(r => setTimeout(r, 300));
        prog.currentChainChunksDone = i;
        prog.currentChainTransfers = i * 210;
      }
      prog.completedChains = 2;
      prog.totalTransfers = 11633;
      prog.currentChain = 'Processing...';
      await new Promise(r => setTimeout(r, 1000));
      const mock = generateMockResult(id);
      onchainCache.set(id, mock);
      onchainProgress.delete(id);
      console.log(`[Onchain Mock] ${id} simulated scan complete`);
    })();

    return c.json({ message: 'SUCCESS', status: 'fetching', cached: false, summary: { totalChains: 2 } });
  }

  // Check cache BEFORE API key validation — cached data doesn't need Etherscan
  const noCache = c.req.query('nocache') === '1';
  const cached = onchainCache.get(id);
  if (!noCache && cached) {
    return c.json({ message: 'SUCCESS', cached: true, ...cached.data });
  }

  if (!ETHERSCAN_KEY) return c.json({ error: 'ETHERSCAN_API_KEY not configured' }, 500);

  const existingProgress = onchainProgress.get(id);
  if (existingProgress && existingProgress.status === 'fetching') {
    return c.json({ message: 'SUCCESS', status: 'fetching', cached: false, summary: { totalChains: existingProgress.totalChains } });
  }

  try {
    const coin = await getCoinDetail(id);
    if (!coin) return c.json({ error: 'Token not found' }, 404);

    const platforms = coin.platforms;
    const tokenName = coin.name;
    const tokenSymbol = coin.symbol;
    const circulatingSupply = coin.market_data?.circulating_supply || 0;

    let decimals = 18;
    const decVals = Object.values(coin.detail_platforms).map(p => p.decimal_place).filter(n => typeof n === 'number' && n > 0);
    if (decVals.length > 0) decimals = Math.max(...decVals);

    const allSupported = Object.entries(platforms)
      .filter(([chain, addr]) => CHAINS[chain] && addr && addr.length > 0)
      .map(([chain, addr]) => ({ chain, address: addr, ...CHAINS[chain] }))
      .sort((a, b) => (a.source === 'etherscan' ? 0 : 1) - (b.source === 'etherscan' ? 0 : 1));
    const supported = allSupported.slice(0, 3);

    if (supported.length === 0) {
      return c.json({
        message: 'SUCCESS',
        token: { id, name: tokenName, symbol: tokenSymbol },
        chains: [], metrics: {}, events: {},
        summary: { totalChains: 0, note: 'No ERC20 deployments on supported chains' },
      });
    }

    // Synchronous scan — blocks until complete. Cloud Run has 300s timeout.
    const ninetyDaysAgo = Math.floor(Date.now() / 1000) - 90 * 86400;
    const allTransfers: RawTransfer[] = [];
    const chainSummaries: { name: string; chainId: number; contract: string; transfers: number; error?: string }[] = [];

    onchainProgress.set(id, {
      status: 'fetching', totalChains: supported.length, completedChains: 0,
      currentChain: supported[0]?.name || '', totalTransfers: 0, startedAt: Date.now(),
      currentChainChunks: 0, currentChainChunksDone: 0, currentChainTransfers: 0,
    });

    for (const entry of supported) {
      const { address, chainId, name } = entry;
      const prog = onchainProgress.get(id);
      if (prog) prog.currentChain = name;

      try {
        const txs = await fetchTokenTxs(entry, address, ninetyDaysAgo, (chunksDone, totalChunks, txsSoFar) => {
          const prog = onchainProgress.get(id);
          if (prog) { prog.currentChainChunks = totalChunks; prog.currentChainChunksDone = chunksDone; prog.currentChainTransfers = txsSoFar; }
        });
        for (const tx of txs) allTransfers.push(tx);
        chainSummaries.push({ name, chainId, contract: address, transfers: txs.length });
        if (prog) { prog.completedChains++; prog.totalTransfers += txs.length; }
      } catch (err: any) {
        chainSummaries.push({ name, chainId, contract: address, transfers: 0, error: err?.message?.slice(0, 80) });
        if (prog) prog.completedChains++;
      }
      await new Promise(r => setTimeout(r, 250));
    }

    const prog = onchainProgress.get(id);
    if (prog) prog.currentChain = 'Processing...';
    const processed = processTransfers(allTransfers, circulatingSupply, decimals);
    processed.summary.chainsWithData = chainSummaries.filter(cc => cc.transfers > 0).length;

    const result = {
      token: { id, name: tokenName, symbol: tokenSymbol, decimals, circulatingSupply },
      chains: chainSummaries, ...processed,
    };

    onchainCache.set(id, result);
    onchainProgress.delete(id);
    console.log(`[Onchain] ${id} scan complete: ${allTransfers.length} transfers across ${chainSummaries.length} chains`);

    return c.json({ message: 'SUCCESS', cached: false, ...result });
  } catch (error: any) {
    console.error('[Onchain]', error);
    return c.json({ error: `Failed: ${error?.message}` }, 500);
  }
});

// Progress sub-route
onchainRoute.get('/progress', async (c) => {
  const id = c.req.query('id');
  if (!id) return c.json({ error: 'id required' }, 400);

  const prog = onchainProgress.get(id);
  if (!prog) return c.json({ status: 'idle' });

  return c.json({
    status: prog.status,
    totalChains: prog.totalChains,
    completedChains: prog.completedChains,
    currentChain: prog.currentChain,
    totalTransfers: prog.totalTransfers,
    elapsed: Math.floor((Date.now() - prog.startedAt) / 1000),
    currentChainChunks: prog.currentChainChunks,
    currentChainChunksDone: prog.currentChainChunksDone,
    currentChainTransfers: prog.currentChainTransfers,
  });
});

// Cache clear (for testing)
onchainRoute.delete('/cache', async (c) => {
  const id = c.req.query('id');
  if (id) {
    onchainCache.delete(id);
    onchainProgress.delete(id);
    return c.json({ cleared: id });
  }
  onchainCache.clear();
  onchainProgress.clear();
  return c.json({ cleared: 'all' });
});
