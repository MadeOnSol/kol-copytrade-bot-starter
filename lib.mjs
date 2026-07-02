/**
 * Paper-trade engine — pure logic, no I/O, unit-testable.
 *
 * Strategy (deliberately simple — this is a starter, not alpha):
 *   - When a tracked KOL BUYS with >= minKolSol, open a paper position of
 *     paperSol at the trade's market cap (market_cap_usd_at_trade).
 *   - When the SAME KOL SELLS that token, close the position at the sell
 *     trade's market cap ("copy the exit").
 *   - PnL is proportional to the MC multiple: pnl = entry_sol * (exit/entry - 1).
 *
 * This is PAPER ONLY. MadeOnSol is a data API — it never executes trades,
 * and neither does this starter.
 */

export function createPaperEngine(cfg = {}) {
  const paperSol = cfg.paperSol ?? 0.5;
  const minKolSol = cfg.minKolSol ?? 1;
  const follow = new Set((cfg.follow ?? []).filter(Boolean));
  const maxPositions = cfg.maxPositions ?? 10;
  const state = cfg.state ?? { positions: {}, closed: [], realized_sol: 0 };

  /**
   * Feed one KOL trade (REST /kol/feed row or WS kol:trade frame data — same
   * field names). Returns { type: "open"|"close", position } or null.
   */
  function onTrade(t) {
    if (!t || !t.token_mint || !t.wallet_address) return null;
    const mc = Number(t.market_cap_usd_at_trade);

    if (t.action === "buy") {
      if (Number(t.sol_amount) < minKolSol) return null;
      if (follow.size > 0 && !follow.has(t.wallet_address)) return null;
      if (!Number.isFinite(mc) || mc <= 0) return null; // no MC → no basis to paper-trade
      if (state.positions[t.token_mint]) return null; // one position per token
      if (Object.keys(state.positions).length >= maxPositions) return null;

      const position = {
        mint: t.token_mint,
        // strip any leading $ — some symbols arrive pre-prefixed
        symbol: (t.token_symbol || t.token_name || "?").replace(/^\$+/, ""),
        kol: t.kol_name || t.wallet_address.slice(0, 4) + "…",
        kol_wallet: t.wallet_address,
        entry_mc: mc,
        entry_sol: paperSol,
        opened_at: t.traded_at || new Date().toISOString(),
      };
      state.positions[t.token_mint] = position;
      return { type: "open", position };
    }

    if (t.action === "sell") {
      const pos = state.positions[t.token_mint];
      if (!pos) return null;
      if (pos.kol_wallet !== t.wallet_address) return null; // only copy OUR kol's exit
      if (!Number.isFinite(mc) || mc <= 0) return null;

      delete state.positions[t.token_mint];
      const multiple = mc / pos.entry_mc;
      const pnl_sol = pos.entry_sol * (multiple - 1);
      state.realized_sol += pnl_sol;
      const closed = {
        ...pos,
        exit_mc: mc,
        closed_at: t.traded_at || new Date().toISOString(),
        multiple,
        pnl_sol,
      };
      state.closed.push(closed);
      return { type: "close", position: closed };
    }

    return null;
  }

  return { onTrade, state };
}

/** Compact money formatter: 1234567 → "$1.23M" */
export function fmtUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  n = Number(n);
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

/** Signed SOL formatter: 0.1234 → "+0.123 SOL" */
export function fmtSol(n) {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(3)} SOL`;
}
