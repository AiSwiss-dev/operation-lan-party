// =====================================================================
//  Zustands-Synchronisation
//  * Realtime-Events lösen ein (entprelltes) Neuladen des Zustands aus.
//  * "LIVE" gilt erst, wenn der Realtime-Kanal verbunden ist UND schon
//    mindestens ein echtes Event angekommen ist. Bis dahin (oder wenn
//    Realtime ausfällt) wird alle 2,5 s nachgeladen, im LIVE-Betrieb nur
//    alle 8 s zur Sicherheit.
//  * Bei Netzwerkfehlern: Meldung "VERBINDUNG ZUM HQ VERLOREN" und
//    Wiederholung mit wachsender Pause. Der zuletzt bekannte Zustand
//    bleibt dabei stehen – es wird nichts zurückgesetzt.
// =====================================================================

export function createSync({
  fetchState,
  onState,
  onError = () => {},
  onConnection = () => {},
  onLink = () => {},          // 'live' | 'fallback' | 'offline'
  liveIntervalMs = 8000,
  fallbackIntervalMs = 2500,
}) {
  let inFlight = false;
  let pending = false;
  let stopped = false;
  let subscribed = false;
  let eventSeen = false;
  let connected = true;
  let retryDelay = 1000;
  let pollTimer = null;
  let debounceTimer = null;
  let lastLink = null;

  const isLive = () => subscribed && eventSeen;

  function emitLink() {
    const link = !connected ? 'offline' : isLive() ? 'live' : 'fallback';
    if (link !== lastLink) {
      lastLink = link;
      onLink(link);
    }
  }

  function setConnected(value) {
    if (connected !== value) {
      connected = value;
      onConnection(value);
    }
    emitLink();
  }

  function schedule() {
    clearTimeout(pollTimer);
    if (stopped) return;
    let delay;
    if (!connected) {
      delay = retryDelay;
      retryDelay = Math.min(retryDelay * 2, 8000);
    } else {
      delay = isLive() ? liveIntervalMs : fallbackIntervalMs;
    }
    pollTimer = setTimeout(run, delay);
  }

  async function run() {
    if (stopped) return;
    if (inFlight) { pending = true; return; }
    inFlight = true;
    pending = false;
    try {
      const state = await fetchState();
      retryDelay = 1000;
      setConnected(true);
      if (!stopped) onState(state);
    } catch (e) {
      if (e && e.network) setConnected(false);
      else if (!stopped) onError(e);
    } finally {
      inFlight = false;
      if (pending && !stopped) setTimeout(run, 0);
      else schedule();
    }
  }

  function request(delay = 120) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(run, delay);
  }

  const onOnline = () => request(0);
  const onOffline = () => setConnected(false);
  const onVisible = () => { if (document.visibilityState === 'visible') request(0); };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisible);

  emitLink();

  return {
    request,
    refresh: run,
    // vom Realtime-Kanal: verbunden ja/nein
    setSubscribed(value) {
      const was = subscribed;
      subscribed = value;
      if (!value) eventSeen = false; // nach Reconnect erst wieder ein Event abwarten
      emitLink();
      if (value && !was) request(0); // nach (Wieder-)Verbindung sofort neu laden
      else schedule();
    },
    // vom Realtime-Kanal: ein Event ist angekommen
    realtimeEvent() {
      if (!eventSeen) {
        eventSeen = true;
        emitLink();
      }
      request();
    },
    isConnected: () => connected,
    stop() {
      stopped = true;
      clearTimeout(pollTimer);
      clearTimeout(debounceTimer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
