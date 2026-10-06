// =====================================================================
//  Verbindung zu Supabase: Client, RPC-Aufrufe mit Timeout und
//  verständlichen Fehlercodes, Realtime-Abo für eine Mission.
// =====================================================================

import { createClient } from './vendor/supabase.js';

let CONFIG = null;
try {
  ({ CONFIG } = await import('./config.js'));
} catch {
  CONFIG = null;
}

// Schutz vor dem gefährlichsten Konfigurationsfehler: Service-Role-/Secret-Key im Browser
function looksLikeSecretKey(key) {
  if (/^sb_secret_/i.test(key)) return true;
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload && payload.role === 'service_role';
  } catch {
    return false;
  }
}

function checkConfig() {
  if (!CONFIG) return { ok: false, reason: 'missing' };
  const url = String(CONFIG.SUPABASE_URL || '').trim();
  const key = String(CONFIG.SUPABASE_ANON_KEY || '').trim();
  if (!url || !key || url.includes('DEIN-PROJEKT') || key.includes('DEIN-')) return { ok: false, reason: 'placeholder' };
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) return { ok: false, reason: 'url' };
  } catch {
    return { ok: false, reason: 'url' };
  }
  if (looksLikeSecretKey(key)) return { ok: false, reason: 'secret' };
  return { ok: true, url, key };
}

export const configStatus = checkConfig();

export const supabase = configStatus.ok
  ? createClient(configStatus.url, configStatus.key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 20 } },
    })
  : null;

export class RpcError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
    this.network = code === 'NETWORK';
  }
}

const KNOWN = /^[A-Z][A-Z_]+$/;

function toRpcError(error, status) {
  const message = String(error?.message || '');
  if (KNOWN.test(message)) return new RpcError(message, error);
  if (status === 401 || /invalid api key|no api key/i.test(message)) return new RpcError('CONFIG_KEY', error);
  // Funktion fehlt → schema.sql wurde (noch) nicht ausgeführt
  if (error?.code === 'PGRST202' || error?.code === '42883' || /could not find the function/i.test(message)) {
    return new RpcError('SETUP', error);
  }
  if (error?.code === '42501' || /permission denied/i.test(message)) return new RpcError('SETUP', error);
  return new RpcError('NETWORK', error);
}

// RPC mit Timeout. Wirft RpcError mit .code (z. B. CALLSIGN_TAKEN, NETWORK).
export async function rpc(fn, args = {}, { timeoutMs = 10000 } = {}) {
  if (!supabase) throw new RpcError('SETUP');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { data, error, status } = await supabase.rpc(fn, args).abortSignal(controller.signal);
    if (error) throw toRpcError(error, status);
    return data;
  } catch (e) {
    if (e instanceof RpcError) throw e;
    throw new RpcError('NETWORK', e);
  } finally {
    clearTimeout(timer);
  }
}

// Realtime: meldet jede Änderung an der Mission bzw. ihren Spielern.
// Die Events selbst enthalten keine Spiellogik – sie lösen nur ein
// erneutes Laden des Zustands per RPC aus. Doppelte oder verspätete
// Events sind dadurch harmlos.
export function watchGame(gameId, { onChange, onLive }) {
  if (!supabase) return () => {};
  const channel = supabase
    .channel(`olp-game-${gameId}-${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `id=eq.${gameId}` }, () => onChange('games'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `game_id=eq.${gameId}` }, () => onChange('players'))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'players' }, () => onChange('players'))
    .subscribe((status) => onLive(status === 'SUBSCRIBED'));
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    supabase.removeChannel(channel);
  };
}
