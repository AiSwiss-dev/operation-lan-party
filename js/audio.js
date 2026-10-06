// =====================================================================
//  Sounds
//  * Kurze Effekte (Lock, Richtig, Falsch, …) werden mit der Web Audio API
//    selbst erzeugt – keine Dateien nötig.
//  * Zwei Audiodateien aus dem Ordner sounds/:
//      titelmusic  – läuft in Lobby, Ergebnis-Screens, Zwischenranking und Finale
//                    (in Schleife, setzt jeweils dort fort, wo sie aufgehört hat)
//      bombsound   – läuft während der Antwortzeit; synchronisiert auf die
//                    Serverzeit, sodass die Explosion genau bei 0 kommt
//    Welches Gerät was abspielt: SOUND_SETUP in js/questions.js
//  Alles läuft über EINEN AudioContext (Web Audio API). Browser – vor allem
//  iPhones – geben Ton erst nach einem Tippen frei; danach können Musik und
//  Bombe jederzeit starten, die Lautstärke funktioniert überall und die
//  Bombe lässt sich millisekundengenau positionieren.
// =====================================================================

import { storage } from './utils.js';
import { SOUND_FILES } from './questions.js';

const KEY = 'olp.sound';
let ctx = null;
let master = null;
let enabled = storage.get(KEY, true) !== false;
const listeners = new Set();
const isPhone = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

function ensureContext() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    // Auf Handys mit niedrigerer Abtastrate → halber Speicherbedarf für die Musik
    try { ctx = isPhone ? new AC({ sampleRate: 24000 }) : new AC(); } catch { ctx = new AC(); }
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    ctx.addEventListener?.('statechange', () => {
      if (ctx.state === 'running') for (const track of Object.values(tracks)) track.retry();
    });
  } catch {
    ctx = null;
  }
  return ctx;
}

// Ton freischalten – muss aus einem Tippen/Klicken heraus aufgerufen werden
export function unlockAudio() {
  const c = ensureContext();
  if (!c) return;
  // iPhone: Ton auch bei aktiviertem Lautlos-Schalter (iOS 17+)
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* egal */ }
  if (c.state !== 'running') c.resume().then(retryTracks, () => {});
  try {
    const buffer = c.createBuffer(1, 1, c.sampleRate);
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(c.destination);
    src.start(0);
  } catch { /* egal */ }
  retryTracks();
}

function retryTracks() {
  for (const track of Object.values(tracks)) track.retry();
}

export function audioLocked() {
  return !ctx || ctx.state !== 'running';
}

export function initAudio() {
  const handler = () => unlockAudio();
  for (const ev of ['pointerdown', 'keydown', 'touchend']) {
    window.addEventListener(ev, handler, { passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  });
}

function tone({ freq, to = null, dur = 0.12, type = 'square', vol = 0.12, at = 0, attack = 0.005 }) {
  if (!enabled) return;
  const c = ensureContext();
  if (!c || c.state !== 'running') return;
  const t = c.currentTime + at;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(vol, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function noise({ dur = 0.15, vol = 0.08, at = 0, filter = 1800 }) {
  if (!enabled) return;
  const c = ensureContext();
  if (!c || c.state !== 'running') return;
  const t = c.currentTime + at;
  const len = Math.floor(c.sampleRate * dur);
  const buffer = c.createBuffer(1, len, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buffer;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = Math.min(filter, c.sampleRate / 2 - 100);
  const gain = c.createGain();
  gain.gain.value = vol;
  src.connect(bp).connect(gain).connect(master);
  src.start(t);
}

export const sfx = {
  missionStart() {
    noise({ dur: 0.25, vol: 0.06, filter: 900 });
    [392, 523, 659].forEach((f, i) => tone({ freq: f, dur: 0.14, at: 0.08 + i * 0.11, type: 'sawtooth', vol: 0.07 }));
  },
  lock() {
    tone({ freq: 1400, to: 900, dur: 0.06, type: 'square', vol: 0.08 });
    tone({ freq: 700, dur: 0.08, at: 0.05, type: 'triangle', vol: 0.12 });
  },
  correct() {
    tone({ freq: 660, dur: 0.12, type: 'triangle', vol: 0.16 });
    tone({ freq: 990, dur: 0.22, at: 0.1, type: 'triangle', vol: 0.16 });
  },
  wrong() {
    tone({ freq: 180, to: 110, dur: 0.35, type: 'sawtooth', vol: 0.09 });
  },
  tick() {
    tone({ freq: 1800, dur: 0.04, type: 'square', vol: 0.05 });
  },
  expired() {
    tone({ freq: 440, to: 220, dur: 0.3, type: 'square', vol: 0.07 });
  },
  accomplished() {
    const notes = [523, 659, 784, 1046, 784, 1046];
    notes.forEach((f, i) => tone({ freq: f, dur: i === notes.length - 1 ? 0.6 : 0.16, at: i * 0.15, type: 'triangle', vol: 0.15 }));
    noise({ dur: 0.4, vol: 0.04, at: 0.75, filter: 3000 });
  },
};

export function isSoundEnabled() {
  return enabled;
}

export function setSoundEnabled(value) {
  enabled = !!value;
  storage.set(KEY, enabled);
  if (enabled) unlockAudio();
  else for (const track of Object.values(tracks)) track.mute();
  listeners.forEach((fn) => fn(enabled));
}

// ---------------------------------------------------------------------
// Audiodateien (Titelmusik, Bombe)
// ---------------------------------------------------------------------

// Reihenfolge der Formate: Apple-Browser zuerst .m4a, alle anderen .webm
function candidateFiles(base) {
  const ua = navigator.userAgent;
  const apple = /iPhone|iPad|iPod|Macintosh/.test(ua) && !/Chrome|Chromium|Edg|Firefox|FxiOS|CriOS/.test(ua);
  let webm = '';
  try { webm = document.createElement('audio').canPlayType('audio/webm; codecs="opus"'); } catch { /* egal */ }
  return webm && !apple ? [`${base}.webm`, `${base}.m4a`] : [`${base}.m4a`, `${base}.webm`];
}

function decode(c, data) {
  return new Promise((resolve, reject) => {
    const p = c.decodeAudioData(data, resolve, reject); // Safari: Callback-Variante
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

class Track {
  constructor({ base, volume, loop }) {
    this.base = base;
    this.volume = volume;
    this.loop = loop;
    this.buffer = null;    // dekodierte Audiodaten
    this.loading = false;
    this.failed = false;   // Datei fehlt / kein Format abspielbar
    this.file = null;
    this.source = null;    // laufender AudioBufferSourceNode
    this.gain = null;
    this.startedAt = 0;    // ctx.currentTime beim Start
    this.offset = 0;       // Dateiposition beim Start (bzw. beim Anhalten)
    this.wanted = false;   // soll gerade laufen
    this.fadeTimer = null;
    this.sessionKey = null;
  }

  // Datei einmal komplett laden und dekodieren (funktioniert mit jedem
  // Webserver, auch ohne HTTP-Range, z. B. python -m http.server)
  ensure() {
    if (this.buffer || this.loading || this.failed) return;
    const c = ensureContext();
    if (!c) { this.failed = true; return; }
    this.loading = true;
    (async () => {
      for (const file of candidateFiles(this.base)) {
        try {
          const res = await fetch(file);
          if (!res.ok) continue;
          const buf = await decode(c, await res.arrayBuffer());
          this.buffer = buf;
          this.file = file;
          return;
        } catch { /* nächstes Format probieren */ }
      }
      throw new Error('keine abspielbare Datei');
    })().then(() => { this.loading = false; this.retry(); },
      () => { this.loading = false; this.failed = true; this.wanted = false; });
  }

  preload() { this.ensure(); }
  get ready() { return !!this.buffer; }
  get available() { return !this.failed; }
  get playing() { return !!this.source && !!ctx && ctx.state === 'running'; }
  duration() { return this.buffer ? this.buffer.duration : null; }

  position() {
    if (!this.source || !ctx) return this.offset;
    let p = this.offset + (ctx.currentTime - this.startedAt);
    if (this.loop && this.buffer) p %= this.buffer.duration;
    return p;
  }

  killSource() {
    if (!this.source) return;
    const s = this.source;
    this.source = null;
    s.onended = null;
    try { s.stop(); } catch { /* schon beendet */ }
  }

  startAt(pos, fadeInMs = 0) {
    const c = ctx;
    this.killSource();
    if (!this.gain) {
      this.gain = c.createGain();
      this.gain.connect(c.destination);
    }
    const g = this.gain.gain;
    g.cancelScheduledValues(c.currentTime);
    if (fadeInMs > 0) {
      g.setValueAtTime(0.0001, c.currentTime);
      g.linearRampToValueAtTime(this.volume, c.currentTime + fadeInMs / 1000);
    } else {
      g.setValueAtTime(this.volume, c.currentTime);
    }
    const offset = Math.max(0, Math.min(pos, this.buffer.duration - 0.01));
    const src = c.createBufferSource();
    src.buffer = this.buffer;
    src.loop = this.loop;
    src.connect(this.gain);
    src.onended = () => {
      if (this.source !== src) return;
      this.source = null;
      this.offset = this.buffer.duration;
      this.wanted = false;
    };
    src.start(0, offset);
    this.source = src;
    this.startedAt = c.currentTime;
    this.offset = offset;
  }

  play(fromPos = null, { fadeInMs = 0 } = {}) {
    this.wanted = true;
    this.fadeInMs = fadeInMs;
    if (fromPos !== null) this.offset = fromPos;
    this.ensure();
    if (this.fadeTimer) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
      if (this.source && ctx) {
        const g = this.gain.gain;
        g.cancelScheduledValues(ctx.currentTime);
        g.setValueAtTime(this.volume, ctx.currentTime);
      }
    }
    if (!enabled || !this.buffer || !ctx || ctx.state !== 'running') return; // startet später (retry)
    if (!this.source || fromPos !== null) this.startAt(this.offset, this.fadeInMs);
  }

  seek(pos) {
    if (this.source && ctx && this.buffer) this.startAt(pos);
    else this.offset = pos;
  }

  stop({ fadeMs = 0, rewind = true } = {}) {
    this.wanted = false;
    if (!this.source || !ctx) {
      if (rewind) this.offset = 0;
      return;
    }
    if (this.fadeTimer) return;
    if (!fadeMs) {
      const pos = this.position();
      this.killSource();
      this.offset = rewind ? 0 : pos;
      return;
    }
    const src = this.source;
    const g = this.gain.gain;
    const now = ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + fadeMs / 1000);
    this.fadeTimer = setTimeout(() => {
      this.fadeTimer = null;
      if (this.source === src) {
        const pos = this.position();
        this.killSource();
        this.offset = rewind ? 0 : pos;
      }
    }, fadeMs + 40);
  }

  // SOUND OFF: anhalten, aber "wanted" behalten → SOUND ON spielt weiter
  mute() {
    if (!this.source) return;
    this.offset = this.position();
    this.killSource();
  }

  // nach Freischalten, Laden oder SOUND ON erneut versuchen
  retry() {
    if (this.wanted && !this.source && !this.fadeTimer) this.play(null, { fadeInMs: this.fadeInMs || 0 });
  }
}

export const tracks = {
  music: new Track(SOUND_FILES.music),
  bomb: new Track(SOUND_FILES.bomb),
};

// Nur zur Diagnose (Browser-Konsole / automatische Tests): window.__olpSound()
window.__olpSound = () => Object.fromEntries(Object.entries(tracks).map(([name, t]) => [name, {
  wanted: t.wanted, playing: t.playing, pos: Math.round(t.position() * 100) / 100, failed: t.failed,
  file: t.file ? t.file.split('/').pop() : null, ready: t.ready, locked: audioLocked(),
}]));

// Wird alle 200 ms mit dem aktuellen Spielzustand aufgerufen.
//   music → Titelmusik in Lobby, Ergebnis, Zwischenranking und Finale (MUSIC_STATES).
//           Wartet, bis die Bombe ausgeklungen ist, und blendet dann ein.
//   bomb  → Bombe während der Antwortzeit, Explosion genau bei 0.
//           Schließt der Host die Antworten vorzeitig, springt sie zur
//           Explosion; wird das Ergebnis vorher gezeigt, blendet sie aus.
const MUSIC_STATES = ['lobby', 'results', 'phase_break', 'finished'];

export function updateSoundscape(game, now, { music = false, bomb = false } = {}) {
  const m = tracks.music;
  const bombBusy = tracks.bomb.playing;
  if (music && game && MUSIC_STATES.includes(game.status) && !bombBusy) {
    if (m.gameKey !== game.id) { // neue Mission → Musik von vorn
      m.gameKey = game.id;
      if (!m.wanted) m.offset = 0;
    }
    if (!m.wanted) m.play(null, { fadeInMs: game.status === 'lobby' ? 600 : game.status === 'finished' ? 3000 : 2000 });
  } else if (m.wanted) {
    // fortsetzen statt neu starten, wenn sie das nächste Mal läuft
    m.stop({ fadeMs: 1200, rewind: !game });
  }

  const t = tracks.bomb;
  if (!bomb || !game) {
    if (t.wanted) t.stop({ fadeMs: 300 });
    return;
  }
  const explosionAt = SOUND_FILES.bomb.explosionAt;
  const running = game.status === 'question' && game.started_at_ms && game.ends_at_ms && now >= game.started_at_ms;
  if (running) {
    const pos = explosionAt - (game.ends_at_ms - now) / 1000;
    const length = t.duration() || SOUND_FILES.bomb.length;
    if (pos < 0 || pos >= length) return; // noch zu früh (lange Antwortzeit) bzw. schon vorbei
    const key = `${game.id}:${game.current_question}`;
    if (t.sessionKey !== key) {
      t.sessionKey = key;
      t.play(pos);
      return;
    }
    if (t.wanted && t.playing && Math.abs(t.position() - pos) > 0.3) t.seek(pos);
    else if (t.wanted && !t.source) t.offset = pos; // gesperrt/noch am Laden: Startposition aktuell halten
    return;
  }
  // Frage beendet: vor der Explosion ausblenden, den Nachhall ausklingen lassen
  if (t.wanted && t.position() < explosionAt - 0.1) t.stop({ fadeMs: 400 });
}

// Spielt dieses Gerät die Bomben-Datei? (dann keine synthetischen Ticks)
export function bombTrackActive(setup) {
  return !!(setup && setup.bomb && enabled && tracks.bomb.available);
}

// Hinweis-Button "TIPPEN FÜR SOUND", solange der Browser den Ton noch sperrt
// (z. B. nach einem Neuladen der Seite ohne Tippen)
export function updateUnlockHint(wanted) {
  let btn = document.getElementById('sound-unlock');
  const show = wanted && enabled && audioLocked();
  if (!show) {
    if (btn) btn.hidden = true;
    return;
  }
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'sound-unlock';
    btn.type = 'button';
    btn.className = 'sound-unlock';
    btn.textContent = 'TIPPEN FÜR SOUND';
    btn.addEventListener('click', () => { unlockAudio(); btn.hidden = true; });
    document.body.append(btn);
  }
  btn.hidden = false;
}

// Verbindet einen Button mit dem Sound-Schalter ("SOUND ON" / "SOUND OFF")
export function bindSoundToggle(button) {
  const render = (on) => {
    button.textContent = on ? 'SOUND ON' : 'SOUND OFF';
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  render(enabled);
  button.addEventListener('click', () => setSoundEnabled(!enabled));
  listeners.add(render);
}
