// =====================================================================
//  Serverzeit-Synchronisation
//  Alle Geräte rechnen den Countdown aus question_ends_at (Serverzeit).
//  Damit falsch gehende Handy-Uhren keine Rolle spielen, misst jedes Gerät
//  den Versatz zur Serveruhr (mehrere Messungen, die mit der kürzesten
//  Laufzeit gewinnt, Netzwerklatenz = halbe Laufzeit).
//  Gerechnet wird mit performance.now() → unabhängig von Uhr-Umstellungen.
// =====================================================================

import { rpc } from './supabase-client.js';

let base = null;          // { server: ms, perf: performance.now() }
let bestRtt = Infinity;
let syncing = null;

export function serverNow() {
  if (!base) return Date.now();
  return base.server + (performance.now() - base.perf);
}

export function isClockSynced() {
  return bestRtt !== Infinity;
}

async function sample() {
  const t0 = performance.now();
  const server = Number(await rpc('server_time', {}, { timeoutMs: 5000 }));
  const t1 = performance.now();
  return { rtt: t1 - t0, server: server + (t1 - t0) / 2, perf: t1 };
}

export function syncClock(samples = 5) {
  if (syncing) return syncing;
  syncing = (async () => {
    let best = null;
    for (let i = 0; i < samples; i++) {
      try {
        const s = await sample();
        if (!best || s.rtt < best.rtt) best = s;
      } catch {
        /* einzelne Messung verloren – egal */
      }
    }
    if (best) {
      base = { server: best.server, perf: best.perf };
      bestRtt = best.rtt;
    }
    return !!best;
  })().finally(() => { syncing = null; });
  return syncing;
}

// Grobe Notlösung, solange noch keine echte Messung vorliegt
export function roughSync(serverMs) {
  if (isClockSynced() || !Number.isFinite(serverMs)) return;
  base = { server: serverMs, perf: performance.now() };
}

let periodic = null;
export function keepClockSynced(intervalMs = 60000) {
  if (periodic) return;
  periodic = setInterval(() => syncClock(3), intervalMs);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncClock(3);
  });
  window.addEventListener('online', () => syncClock(3));
}
