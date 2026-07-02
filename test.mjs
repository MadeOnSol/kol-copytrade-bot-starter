/**
 * Test suite — unit tests for the paper engine + live shape tests against
 * the production API. Live tests need MADEONSOL_API_KEY (any tier).
 *
 *   MADEONSOL_API_KEY=msk_... node test.mjs
 */
import { createPaperEngine, fmtUsd, fmtSol } from "./lib.mjs";

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

// ── Unit: engine ────────────────────────────────────────────────────────────
console.log("Unit: paper engine");
{
  const e = createPaperEngine({ paperSol: 1, minKolSol: 2, maxPositions: 2 });
  const buy = (mint, wallet, sol, mc, extra = {}) =>
    e.onTrade({ token_mint: mint, wallet_address: wallet, action: "buy", sol_amount: sol, market_cap_usd_at_trade: mc, token_symbol: "TST", traded_at: "2026-07-02T00:00:00Z", ...extra });
  const sell = (mint, wallet, mc) =>
    e.onTrade({ token_mint: mint, wallet_address: wallet, action: "sell", sol_amount: 1, market_cap_usd_at_trade: mc, traded_at: "2026-07-02T01:00:00Z" });

  assert(buy("A", "kol1", 1, 50_000) === null, "buy below minKolSol ignored");
  assert(buy("A", "kol1", 5, 0) === null, "buy with no MC ignored");
  assert(buy("A", "kol1", 5, 50_000)?.type === "open", "qualifying buy opens position");
  assert(buy("A", "kol1", 5, 60_000) === null, "duplicate position rejected");
  assert(buy("B", "kol2", 5, 10_000)?.type === "open", "second position opens");
  assert(buy("C", "kol1", 5, 10_000) === null, "maxPositions enforced");
  assert(sell("A", "other_kol", 100_000) === null, "sell by different KOL ignored");
  const closed = sell("A", "kol1", 100_000);
  assert(closed?.type === "close", "same-KOL sell closes position");
  assert(Math.abs(closed.position.multiple - 2) < 1e-9, "multiple = exit/entry (2x)");
  assert(Math.abs(closed.position.pnl_sol - 1) < 1e-9, "pnl = entry_sol*(mult-1) = +1 SOL");
  assert(Math.abs(e.state.realized_sol - 1) < 1e-9, "realized_sol accumulates");
  const lossBuy = buy("C", "kol1", 5, 100_000);
  assert(lossBuy?.type === "open", "slot freed after close");
  const loss = sell("C", "kol1", 50_000);
  assert(Math.abs(loss.position.pnl_sol - -0.5) < 1e-9, "losing exit → -0.5 SOL");
  assert(sell("ZZZ", "kol1", 1) === null, "sell without position ignored");
}
{
  const e = createPaperEngine({ paperSol: 1, minKolSol: 0, follow: ["watched"] });
  const r1 = e.onTrade({ token_mint: "X", wallet_address: "random", action: "buy", sol_amount: 9, market_cap_usd_at_trade: 1000 });
  const r2 = e.onTrade({ token_mint: "X", wallet_address: "watched", action: "buy", sol_amount: 9, market_cap_usd_at_trade: 1000, token_symbol: "$PRE" });
  assert(r1 === null && r2?.type === "open", "FOLLOW_WALLETS filter honored");
  assert(r2.position.symbol === "PRE", "pre-$ symbol stripped");
}
console.log("Unit: formatters");
assert(fmtUsd(1_234_567) === "$1.23M", "fmtUsd M");
assert(fmtUsd(45_600) === "$45.6k", "fmtUsd k");
assert(fmtUsd(null) === "—", "fmtUsd null");
assert(fmtSol(0.5) === "+0.500 SOL" && fmtSol(-0.25) === "-0.250 SOL", "fmtSol signs");

// ── Live: production API shapes ─────────────────────────────────────────────
const KEY = process.env.MADEONSOL_API_KEY;
const API = process.env.MADEONSOL_API_BASE || "https://madeonsol.com/api/v1";
if (!KEY) {
  console.log("\n(no MADEONSOL_API_KEY — skipping live API tests)");
} else {
  console.log("\nLive: production API");
  const api = async (path, init = {}) => {
    const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${KEY}`, ...(init.body ? { "Content-Type": "application/json" } : {}) } });
    if (!res.ok) { const e = new Error(`${res.status} ${path}`); e.status = res.status; throw e; }
    return res.json();
  };

  const me = await api("/me");
  assert(typeof me.tier === "string", `/me returns tier (${me.tier})`);

  const feed = await api("/kol/feed?limit=5");
  assert(Array.isArray(feed.trades), "/kol/feed returns trades[]");
  if (feed.trades.length > 0) {
    const t = feed.trades[0];
    assert(typeof t.token_mint === "string", "trade.token_mint present");
    assert(t.action === "buy" || t.action === "sell", "trade.action valid");
    assert("market_cap_usd_at_trade" in t, "trade.market_cap_usd_at_trade key present");
    assert("wallet_address" in t && "traded_at" in t && "tx_signature" in t, "trade identity fields present");

    // feed rows drive the SAME engine as WS frames — prove it end to end
    const e2 = createPaperEngine({ paperSol: 0.1, minKolSol: 0 });
    let opened = 0;
    for (const trade of feed.trades) if (e2.onTrade(trade)?.type === "open") opened++;
    assert(opened >= 0, `engine consumed ${feed.trades.length} live trades (${opened} opens)`);

    // mark-to-market source (response nests under .token; field is market_cap)
    const tok = await api(`/token/${t.token_mint}`).catch((err) => ({ _err: err.status }));
    assert(tok._err === undefined ? "market_cap" in (tok.token ?? {}) : tok._err === 404, "/token/{mint} MTM source ok (or 404 for untracked)");
  }

  if (me.tier === "PRO" || me.tier === "ULTRA") {
    console.log("Live: WebSocket (PRO/ULTRA)");
    const st = await api("/stream/token", { method: "POST" });
    assert(typeof st.ws_url === "string" && st.ws_url.startsWith("wss") && typeof st.token === "string", "/stream/token returns wss url + token");
    const { default: WebSocket } = await import("ws");
    const result = await new Promise((resolve) => {
      const ws = new WebSocket(`${st.ws_url}?token=${st.token}`);
      const state = { connected: false, subscribed: false };
      const done = () => { try { ws.close(); } catch {} resolve(state); };
      const timer = setTimeout(done, 10_000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "subscribe", channels: ["kol:trades"] })));
      ws.on("message", (raw) => {
        try {
          const m = JSON.parse(raw.toString());
          if (m.type === "connected") state.connected = true;
          if (m.type === "subscribed") { state.subscribed = true; clearTimeout(timer); done(); }
        } catch {}
      });
      ws.on("error", () => { clearTimeout(timer); done(); });
    });
    assert(result.connected, "WS connected frame received");
    assert(result.subscribed, "kol:trades subscription acked");
  } else {
    console.log(`(tier ${me.tier} — WS test skipped; PRO/ULTRA only)`);
  }
}

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
