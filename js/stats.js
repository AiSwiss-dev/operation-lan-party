// =====================================================================
//  CS-STATS für den Game Counter
//  Jeder Spieler aus dem 5er-Team trägt pro Match seine eigene Zeile ein:
//  Kills, Assists, Deaths, HS %, ADR, MVPs. Daraus entsteht ein
//  Leaderboard wie im echten CS-Scoreboard.
// =====================================================================

import { h, mount } from './utils.js';
import { norm } from './account.js';

export const COLS = [
  { key: 'matches', label: 'M', title: 'Matches mit Stats' },
  { key: 'kills', label: 'K', title: 'Kills' },
  { key: 'assists', label: 'A', title: 'Assists' },
  { key: 'deaths', label: 'D', title: 'Deaths' },
  { key: 'kd', label: 'K/D', title: 'Kills pro Death', fmt: (v) => v.toFixed(2) },
  { key: 'diff', label: '+/-', title: 'Kills minus Deaths', fmt: (v) => `${v > 0 ? '+' : ''}${v}` },
  { key: 'hs', label: 'HS %', title: 'Headshot-Quote (Durchschnitt)', fmt: (v) => `${Math.round(v)} %` },
  { key: 'adr', label: 'ADR', title: 'Average Damage per Round (Durchschnitt)', fmt: (v) => String(Math.round(v)) },
  { key: 'mvps', label: 'MVP', title: 'MVP-Sterne' },
];

// Leaderboard über alle Matches (nur Roster-Spieler)
export function aggregate(roster, stats) {
  const names = roster.filter(Boolean);
  const rows = names.map((name) => {
    const mine = stats.filter((s) => norm(s.player) === norm(name));
    const k = mine.reduce((n, s) => n + s.kills, 0);
    const d = mine.reduce((n, s) => n + s.deaths, 0);
    const a = mine.reduce((n, s) => n + s.assists, 0);
    const avg = (f) => (mine.length ? mine.reduce((n, s) => n + s[f], 0) / mine.length : 0);
    return {
      name, matches: mine.length, kills: k, deaths: d, assists: a,
      kd: d ? k / d : k, diff: k - d, hs: avg('hs'), adr: avg('adr'), mvps: mine.reduce((n, s) => n + s.mvps, 0),
    };
  });
  return rows;
}

export function leaderboardTable(rows, sortKey, onSort, me) {
  const sorted = [...rows].sort((x, y) => (y.matches > 0) - (x.matches > 0) || (y[sortKey] - x[sortKey]) || (y.kd - x.kd) || x.name.localeCompare(y.name, 'de'));
  const th = (c) => {
    const btn = h('button', { type: 'button', class: `stats-sort${c.key === sortKey ? ' is-active' : ''}`, title: c.title }, c.label);
    btn.addEventListener('click', () => onSort(c.key));
    return h('th', { scope: 'col', class: 'num', 'aria-sort': c.key === sortKey ? 'descending' : 'none' }, btn);
  };
  return h('table', { class: 'ranking ranking--compact stats-table' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '#' }), h('th', { scope: 'col', text: 'OPERATOR' }), COLS.map(th))),
    h('tbody', {}, sorted.map((r, i) => h('tr', { class: `${i === 0 && r.matches ? 'is-top is-top-1' : ''}${me && norm(me) === norm(r.name) ? ' is-me' : ''}` },
      h('td', { class: 'pos', text: r.matches ? `#${i + 1}` : '–' }),
      h('td', { class: 'name', text: r.name }),
      COLS.map((c) => h('td', { class: `num${c.key === sortKey ? ' is-sorted' : ''}`, text: r.matches ? (c.fmt ? c.fmt(r[c.key]) : String(r[c.key])) : '–' }))))));
}

// Scoreboard eines Matches (sortiert nach Kills, fehlende Spieler = OFFEN)
export function scoreboard(roster, stats, matchId, me) {
  const rows = roster.filter(Boolean).map((name) => ({ name, s: stats.find((x) => x.match_id === matchId && norm(x.player) === norm(name)) }));
  rows.sort((a, b) => (b.s ? b.s.kills : -1) - (a.s ? a.s.kills : -1));
  return h('table', { class: 'ranking ranking--compact stats-board' },
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col', text: 'OPERATOR' }),
      ...['K', 'A', 'D', '+/-', 'HS %', 'ADR', 'MVP'].map((t) => h('th', { scope: 'col', class: 'num', text: t })))),
    h('tbody', {}, rows.map(({ name, s }) => h('tr', { class: `${s ? '' : 'is-open'}${me && norm(me) === norm(name) ? ' is-me' : ''}` },
      h('td', { class: 'name', text: name }),
      ...(s
        ? [s.kills, s.assists, s.deaths, `${s.kills - s.deaths > 0 ? '+' : ''}${s.kills - s.deaths}`, `${s.hs} %`, s.adr, s.mvps].map((v) => h('td', { class: 'num', text: String(v) }))
        : [h('td', { class: 'num stats-open', colspan: '7', text: 'OFFEN – STATS FEHLEN NOCH' })])))));
}

// Dialog: eigene Stats für ein Match eintragen
export function statsDialog({ title, existing, onSubmit }) {
  const fields = [
    ['kills', 'KILLS', 200], ['assists', 'ASSISTS', 200], ['deaths', 'DEATHS', 200],
    ['hs', 'HS %', 100], ['adr', 'ADR', 999], ['mvps', 'MVPs', 50],
  ];
  const inputs = {};
  const grid = h('div', { class: 'stats-form' }, fields.map(([key, label, max]) => {
    const input = h('input', { id: `st-${key}`, class: 'input input--score', type: 'number', inputmode: 'numeric', min: '0', max: String(max), required: true, value: existing ? String(existing[key]) : '' });
    inputs[key] = input;
    return h('div', { class: 'field' }, h('label', { for: `st-${key}`, class: 'field__label' }, label), input);
  }));
  const error = h('p', { class: 'form-error', role: 'alert' });
  const save = h('button', { type: 'submit', class: 'btn btn--primary' }, 'STATS SPEICHERN');
  const cancel = h('button', { type: 'button', class: 'btn btn--ghost' }, 'ABBRECHEN');
  const form = h('form', { class: 'form', novalidate: true },
    grid,
    h('p', { class: 'field__hint', text: 'Werte aus dem CS2-Scoreboard am Ende des Matches. HS % = Headshot-Anteil, ADR = Schaden pro Runde.' }),
    error,
    h('div', { class: 'dialog__actions' }, cancel, save));
  const dialog = h('dialog', { class: 'dialog dialog--wide' },
    h('div', { class: 'dialog__stripes', 'aria-hidden': 'true' }),
    h('h2', { class: 'dialog__title', text: title }),
    form);
  cancel.addEventListener('click', () => dialog.close());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = {};
    for (const [key, label, max] of fields) {
      const raw = inputs[key].value.trim();
      const n = Number(raw);
      if ((raw === '' && key !== 'mvps') || !Number.isInteger(n) || n < 0 || n > max) {
        error.textContent = `${label}: 0–${max} EINTRAGEN`;
        inputs[key].focus();
        return;
      }
      values[key] = raw === '' ? 0 : n;
    }
    save.disabled = true;
    const ok = await onSubmit(values, (msg) => { error.textContent = msg; });
    save.disabled = false;
    if (ok) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  inputs.kills.focus();
}

export { mount };
