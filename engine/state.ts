import { readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { PendingOrderSnapshot, CompletedOrder } from "./market-lifecycle.ts";

export type MarketState = {
  slug: string;
  state: "RUNNING" | "STOPPING";
  strategyName: string;
  clobTokenIds: [string, string];
  pendingOrders: PendingOrderSnapshot[];
  orderHistory: CompletedOrder[];
};

export type CompletedMarketState = {
  slug: string;
  strategyName: string;
  pnl: number;
  orderHistory: CompletedOrder[];
};

export type DailyLossState = {
  /** YYYY-MM-DD (UTC). */
  date: string;
  /** Cumulative negative PnL today (stored as a negative number). */
  lossToday: number;
};

export type PersistentState = {
  sessionPnl: number;
  sessionLoss?: number;
  balance?: number;
  daily?: DailyLossState;
  activeMarkets: MarketState[];
  completedMarkets: CompletedMarketState[];
};

export function loadState(path: string): PersistentState | null {
  try {
    const raw = readFileSync(path, "utf8");
    const state = JSON.parse(raw) as PersistentState;
    state.completedMarkets ??= [];
    return state;
  } catch {
    return null;
  }
}

const MAX_COMPLETED_MARKETS = 20;

export function saveState(path: string, state: PersistentState): void {
  const capped: PersistentState = {
    ...state,
    completedMarkets: state.completedMarkets.slice(-MAX_COMPLETED_MARKETS),
  };
  const tmp = path + ".tmp";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(capped, null, 2), "utf8");
  renameSync(tmp, path);
}
