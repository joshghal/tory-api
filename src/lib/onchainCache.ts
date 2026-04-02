import { type ProcessedOnchain } from './onchainProcessor.js';

// Module-level cache — persists across requests in the same process
const cache = new Map<string, { data: ProcessedOnchain & { chains: any[] }; ts: number }>();

export const onchainCache = {
  get(id: string) {
    const entry = cache.get(id);
    if (!entry) return null;
    if (Date.now() - entry.ts > 3600000) { // 1 hour TTL
      cache.delete(id);
      return null;
    }
    return entry;
  },
  set(id: string, data: ProcessedOnchain & { chains: any[] }) {
    cache.set(id, { data, ts: Date.now() });
  },
  delete(id: string) { cache.delete(id); },
  clear() { cache.clear(); },
};

// Progress tracker
export interface OnchainProgressEntry {
  status: 'fetching' | 'done' | 'error';
  totalChains: number;
  completedChains: number;
  currentChain: string;
  totalTransfers: number;
  startedAt: number;
  currentChainChunks: number;
  currentChainChunksDone: number;
  currentChainTransfers: number;
}

const progress = new Map<string, OnchainProgressEntry>();

export const onchainProgress = {
  get(id: string) { return progress.get(id) || null; },
  set(id: string, entry: OnchainProgressEntry) { progress.set(id, entry); },
  delete(id: string) { progress.delete(id); },
  clear() { progress.clear(); },
};
