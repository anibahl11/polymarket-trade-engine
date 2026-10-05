// N-token Polymarket order book (one event = many YES/NO pairs).
// Same WS protocol as tracker/orderbook.ts, without the UP/DOWN pairing.

import { PriceLevelMap } from "../utils/price-level-map.ts";
import { createReconnectingWs, type ReconnectingWs } from "../utils/reconnecting-ws.ts";
import type { BookSnapshot } from "../engine/client.ts";

const DEFAULT_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

type Level = { price: string; size: string };
type Book = { bids: PriceLevelMap; asks: PriceLevelMap };

export class MultiOrderBook {
  private ws?: ReconnectingWs;
  private ids: string[] = [];
  private books = new Map<string, Book>();
  private ticks = new Map<string, string>();
  private listeners = new Set<(assetId: string) => void>();

  subscribe(assetIds: string[]): void {
    this.destroy();
    this.ids = [...assetIds];
    this.ws = createReconnectingWs({
      url: process.env.ORDERBOOK_WS_URL ?? DEFAULT_WS_URL,
      label: "MentionsBook",
      onopen: (ws) => ws.send(JSON.stringify({ type: "market", assets_ids: this.ids })),
      onmessage: (e) => e.data && this.handle(JSON.parse(e.data as string)),
    });
  }

  destroy(): void {
    this.ws?.destroy();
    this.ws = undefined;
  }

  /** Called with the asset id after every book change. Returns unsubscribe. */
  onUpdate(fn: (assetId: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Exposed for tests and replay. */
  handle(data: any): void {
    const msgs = Array.isArray(data) ? data : [data];
    for (const m of msgs) {
      if (m.event_type === "book") {
        const b = this.book(m.asset_id);
        b.bids.clear();
        b.asks.clear();
        for (const l of m.bids as Level[]) b.bids.set(+l.price, +l.size);
        for (const l of m.asks as Level[]) b.asks.set(+l.price, +l.size);
        if (m.tick_size) this.ticks.set(m.asset_id, m.tick_size);
        this.emit(m.asset_id);
      } else if (m.event_type === "price_change") {
        for (const c of m.price_changes ?? []) {
          const b = this.book(c.asset_id);
          const side = c.side === "BUY" ? b.bids : b.asks;
          const size = +c.size;
          if (size === 0) side.delete(+c.price);
          else side.set(+c.price, size);
          this.emit(c.asset_id);
        }
      } else if (m.event_type === "tick_size_change") {
        this.ticks.set(m.asset_id, m.new_tick_size);
      }
    }
  }

  bestBid(id: string): number | null {
    return this.books.get(id)?.bids.best ?? null;
  }

  bestAsk(id: string): number | null {
    return this.books.get(id)?.asks.best ?? null;
  }

  tickSize(id: string): string {
    return this.ticks.get(id) ?? "0.01";
  }

  /** Shares available to buy at or below `limit` (ask side). */
  askDepth(id: string, limit: number): number {
    const b = this.books.get(id);
    if (!b) return 0;
    let s = 0;
    for (const [p, sz] of b.asks.entries()) {
      if (p > limit) break;
      s += sz;
    }
    return s;
  }

  snapshot(id: string): BookSnapshot {
    const b = this.books.get(id);
    const bid = b?.bids.best ?? null;
    const ask = b?.asks.best ?? null;
    return {
      bestBid: bid,
      bestBidLiquidity: bid !== null ? (b!.bids.get(bid) ?? null) : null,
      bestAsk: ask,
      bestAskLiquidity: ask !== null ? (b!.asks.get(ask) ?? null) : null,
    };
  }

  private book(id: string): Book {
    let b = this.books.get(id);
    if (!b) {
      b = { bids: new PriceLevelMap("desc"), asks: new PriceLevelMap("asc") };
      this.books.set(id, b);
    }
    return b;
  }

  private emit(id: string): void {
    for (const fn of this.listeners) fn(id);
  }
}
