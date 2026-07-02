#!/usr/bin/env node
/**
 * KOL copy-trade PAPER bot — MadeOnSol API starter.
 *
 * Watches live KOL (smart-money) trades on Solana and paper-trades them:
 * opens a virtual position when a tracked KOL buys, closes when they sell,
 * and tracks PnL from the market-cap multiple. No wallet, no keys, no risk.
 *
 * Two modes, auto-selected from your API tier (GET /me):
 *   - FREE key  → REST polling of /kol/feed (rate-limit-safe interval)
 *   - PRO/ULTRA → real-time WebSocket stream (kol:trades channel)
 *
 * Free API key: https://madeonsol.com/pricing  (200 req/day, no payment)
 *
 * MadeOnSol is DATA ONLY — it never executes trades. This starter paper-trades.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createPaperEngine, fmtUsd, fmtSol } from "./lib.mjs";

const API = process.env.MADEONSOL_API_BASE || "https://madeonsol.com/api/v1";
const KEY = process.env.MADEONSOL_API_KEY;
if (!KEY) {
  console.error("Missing MADEONSOL_API_KEY.");
  console.error("Get a free key (200 req/day, ~30s): https://madeonsol.com/pricing");
  process.exit(1);
}

const PAPER_SOL = Number(process.env.PAPER_SOL || 0.5);       // virtual SOL per position
const MIN_KOL_SOL = Number(process.env.MIN_KOL_SOL || 1);     // ignore KOL buys smaller than this
const FOLLOW = (process.env.FOLLOW_WALLETS || "").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_POSITIONS = Number(process.env.MAX_POSITIONS || 10);
const FORCE_POLL = process.env.FORCE_POLL === "1";
const STATE_FILE = process.env.STATE_FILE || "positions.json";

const headers = { Authorization: `Bearer ${KEY}` };

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...headers, ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`API ${res.status} on ${path}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ── State (survives restarts) ──────────────────────────────────────────────
function loadState() {
  if (existsSync(STATE_FILE)) {
    try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { /* corrupt → fresh */ }
  }
  return { positions: {}, closed: [], realized_sol: 0 };
}
const state = loadState();
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const engine = createPaperEngine({
  paperSol: PAPER_SOL,
  minKolSol: MIN_KOL_SOL,
  follow: FOLLOW,
  maxPositions: MAX_POSITIONS,
  state,
});

const seenSignatures = new Set(); // dedup across polls / reconnects
function handleTrade(t) {
  if (t.tx_signature) {
    if (seenSignatures.has(t.tx_signature)) return;
    seenSignatures.add(t.tx_signature);
    if (seenSignatures.size > 5000) seenSignatures.clear(); // cheap cap
  }
  const result = engine.onTrade(t);
  if (!result) return;
  saveState();
  const p = result.position;
  if (result.type === "open") {
    console.log(`🟢 OPEN  $${p.symbol}  ${fmtSol(-p.entry_sol).replace("+", "")} @ MC ${fmtUsd(p.entry_mc)}  (copying ${p.kol})`);
  } else {
    const emoji = p.pnl_sol >= 0 ? "🟣" : "🔴";
    console.log(`${emoji} CLOSE $${p.symbol}  ${p.multiple.toFixed(2)}x → ${fmtSol(p.pnl_sol)}  (${p.kol} exited)`);
    printSummaryLine();
  }
}

function printSummaryLine() {
  const open = Object.keys(state.positions).length;
  console.log(`   📊 realized ${fmtSol(state.realized_sol)} · ${state.closed.length} closed · ${open} open`);
}

async function printPortfolio({ markToMarket = false } = {}) {
  const open = Object.values(state.positions);
  console.log(`\n═══ Paper portfolio ═══  realized ${fmtSol(state.realized_sol)} (${state.closed.length} closed)`);
  if (open.length === 0) { console.log("   (no open positions)\n"); return; }
  for (const p of open) {
    let line = `   $${p.symbol.padEnd(10)} entry MC ${fmtUsd(p.entry_mc)}  via ${p.kol}`;
    if (markToMarket) {
      try {
        const tok = await api(`/token/${p.mint}`);
        const mc = Number(tok.token?.market_cap);
        if (Number.isFinite(mc) && mc > 0) {
          const mult = mc / p.entry_mc;
          line += `  → now ${fmtUsd(mc)} (${mult.toFixed(2)}x, unrealized ${fmtSol(p.entry_sol * (mult - 1))})`;
        }
      } catch { /* untracked/404 — skip MTM for this one */ }
    }
    console.log(line);
  }
  console.log("");
}

// ── Mode 1: REST polling (works on the free tier) ──────────────────────────
async function runPolling(tier) {
  // Free tier = 200 req/day. Default poll interval keeps you inside it
  // (~180 calls/day) with room for the occasional mark-to-market call.
  const defaultInterval = tier === "BASIC" ? 480 : 60;
  const interval = Number(process.env.POLL_SECONDS || defaultInterval);
  console.log(`Mode: REST polling every ${interval}s (tier ${tier}). PRO unlocks the real-time WebSocket → https://madeonsol.com/pricing`);

  let newestSeen = null;
  let polls = 0;
  const poll = async () => {
    try {
      const data = await api(`/kol/feed?limit=50&min_sol=${MIN_KOL_SOL}`);
      const trades = (data.trades ?? []).slice().reverse(); // oldest → newest
      for (const t of trades) {
        if (newestSeen && t.traded_at && t.traded_at <= newestSeen) continue;
        handleTrade(t);
      }
      const newest = data.trades?.[0]?.traded_at;
      if (newest) newestSeen = newest;
      polls++;
      if (polls % 4 === 0) await printPortfolio({ markToMarket: tier !== "BASIC" });
    } catch (err) {
      if (err.status === 429) console.error("Rate limited — consider a longer POLL_SECONDS or PRO (10k req/day).");
      else console.error("Poll error:", err.message);
    }
  };
  await poll();
  setInterval(poll, interval * 1000);
}

// ── Mode 2: WebSocket stream (PRO/ULTRA) ───────────────────────────────────
async function runStream() {
  const { default: WebSocket } = await import("ws");
  let backoff = 5;

  const connect = async () => {
    let wsUrl;
    try {
      // ws_url comes back bare — the auth token is a separate field, append it.
      const st = await api(`/stream/token`, { method: "POST" });
      wsUrl = `${st.ws_url}?token=${st.token}`;
    } catch (err) {
      console.error("Stream token error:", err.message, "— retrying in 15s");
      return setTimeout(connect, 15_000);
    }
    const ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      backoff = 5;
      ws.send(JSON.stringify({ type: "subscribe", channels: ["kol:trades"] }));
      console.log("Mode: real-time WebSocket (kol:trades). Waiting for KOL trades…");
    });
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.event === "kol:trade" && msg.data) handleTrade(msg.data);
    });
    ws.on("close", (code) => {
      console.error(`Stream closed (${code}) — reconnecting in ${backoff}s`);
      setTimeout(connect, backoff * 1000);
      backoff = Math.min(backoff * 2, 60);
    });
    ws.on("error", (err) => console.error("Stream error:", err.message));
  };
  await connect();
  setInterval(() => printPortfolio({ markToMarket: true }), 5 * 60 * 1000);
}

// ── Main ───────────────────────────────────────────────────────────────────
const me = await api(`/me`);
const tier = me.tier || "BASIC";
console.log(`MadeOnSol KOL paper-trader · key tier: ${tier} · paper size ${PAPER_SOL} SOL · min KOL buy ${MIN_KOL_SOL} SOL`);
if (FOLLOW.length) console.log(`Following ${FOLLOW.length} specific wallet(s); other KOLs ignored.`);
await printPortfolio();

process.on("SIGINT", () => {
  console.log("\nShutting down — final state:");
  printSummaryLine();
  saveState();
  process.exit(0);
});

if (!FORCE_POLL && (tier === "PRO" || tier === "ULTRA")) await runStream();
else await runPolling(tier);
