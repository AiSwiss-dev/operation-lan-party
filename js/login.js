// =====================================================================
//  OPERATOR LOGIN (login.html) – Login, Registrierung, Profil
// =====================================================================

import { configStatus, rpc } from './supabase-client.js';
import { h, mount, errorText, toast } from './utils.js';
import { renderConfigError, setNetBanner, stamp, coordLine } from './ui.js';
import { getAccount, setAccount, clearAccount, fetchMe, renderAccountLink } from './account.js';
import { TEXT } from './questions.js';

const app = document.getElementById('app');
const params = new URLSearchParams(window.location.search);
// nur eigene Seiten als Rücksprung erlauben
const returnTo = /^[a-z]+\.html(\?[\w=&%-]*)?$/i.test(params.get('return') || '') && !/^login\.html/i.test(params.get('return')) ? params.get('return') : '';
let refreshTimer = null;

async function init() {
  renderAccountLink();
  if (!configStatus.ok) { renderConfigError(app, configStatus); return; }
  if (getAccount()) await showProfile();
  else renderAuth('login');
}

// ---------------------------------------------------------------------
// Login / Registrierung
// ---------------------------------------------------------------------
function renderAuth(mode, message = '') {
  clearInterval(refreshTimer);
  const isLogin = mode === 'login';
  const user = h('input', { id: 'acc-user', class: 'input', maxlength: '24', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', required: true, placeholder: 'z. B. HeadshotHans' });
  const pass = h('input', { id: 'acc-pass', type: 'password', class: 'input', maxlength: '64', autocomplete: isLogin ? 'current-password' : 'new-password', required: true });
  const pass2 = isLogin ? null : h('input', { id: 'acc-pass2', type: 'password', class: 'input', maxlength: '64', autocomplete: 'new-password', required: true });
  const error = h('p', { id: 'acc-error', class: 'form-error', role: 'alert', text: message });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary btn--block' }, isLogin ? 'LOGIN' : 'ACCOUNT ERSTELLEN');
  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'acc-user', class: 'field__label' }, 'BENUTZERNAME'), user,
      !isLogin ? h('p', { class: 'field__hint', text: '2–24 Zeichen. Wird dein Callsign im Quiz und dein Name im Bracket und in den Stats.' }) : null),
    h('div', { class: 'field' }, h('label', { for: 'acc-pass', class: 'field__label' }, 'PASSWORT'), pass,
      !isLogin ? h('p', { class: 'field__hint', text: 'Mindestens 4 Zeichen.' }) : null),
    pass2 ? h('div', { class: 'field' }, h('label', { for: 'acc-pass2', class: 'field__label' }, 'PASSWORT WIEDERHOLEN'), pass2) : null,
    error,
    submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    if (!user.value.trim() || !pass.value) { error.textContent = 'BENUTZERNAME UND PASSWORT EINGEBEN'; return; }
    if (pass2 && pass.value !== pass2.value) { error.textContent = 'PASSWÖRTER STIMMEN NICHT ÜBEREIN'; pass2.focus(); return; }
    submit.disabled = true;
    try {
      const res = isLogin
        ? await rpc('account_login', { p_username: user.value, p_password: pass.value })
        : await rpc('account_register', { p_username: user.value, p_password: pass.value });
      if (!res.ok) { error.textContent = res.error === 'LOGIN_FAILED' ? 'LOGIN FEHLGESCHLAGEN – NAME ODER PASSWORT FALSCH' : errorText(res.error); return; }
      setAccount(res.token, res.username);
      toast(isLogin ? `WILLKOMMEN ZURÜCK, ${res.username}` : `ACCOUNT ${res.username} ERSTELLT`);
      if (returnTo) { window.location.href = `./${returnTo}`; return; }
      await showProfile();
    } catch (e) {
      error.textContent = errorText(e.code);
    } finally {
      submit.disabled = false;
    }
  });
  const switchBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--block' }, isLogin ? 'NEU HIER? ACCOUNT ERSTELLEN' : 'SCHON EINEN ACCOUNT? LOGIN');
  switchBtn.addEventListener('click', () => renderAuth(isLogin ? 'register' : 'login'));

  mount(app,
    h('section', { class: 'card card--briefing' },
      stamp(isLogin ? 'RESTRICTED' : 'ENLIST'),
      h('p', { class: 'eyebrow', text: TEXT.org }),
      h('h1', { class: 'title title--xl', text: isLogin ? 'OPERATOR LOGIN' : 'ENLIST' }),
      h('p', { class: 'subtitle', text: 'EIN LOGIN FÜR QUIZ, STATS & BRACKET' }),
      h('div', { class: 'stripes', 'aria-hidden': 'true' }),
      form,
      switchBtn,
      coordLine('IDENTIFICATION')));
  user.focus();
}

// ---------------------------------------------------------------------
// Profil
// ---------------------------------------------------------------------
async function showProfile() {
  const me = await fetchMe(true);
  if (!me) { renderAuth('login', getAccount() ? '' : 'BITTE ERNEUT EINLOGGEN'); return; }
  setNetBanner(!!me.offline);
  if (!me.offline) renderProfile(me);
  clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    const next = await fetchMe(false);
    if (!next) { renderAuth('login', 'SITZUNG ABGELAUFEN – BITTE NEU EINLOGGEN'); return; }
    setNetBanner(!!next.offline);
    if (!next.offline) renderProfile(next);
  }, 15000);
}

function statBox(label, value) {
  return h('div', {}, h('dt', { text: label }), h('dd', { text: value }));
}

function renderProfile(me) {
  const t = me.team.totals;
  const kd = t.deaths ? (t.kills / t.deaths).toFixed(2) : (t.kills ? t.kills.toFixed(2) : '–');
  const quiz = me.quiz;
  const quizText = !quiz ? 'Gerade läuft keine Quiz-Mission.'
    : quiz.joined ? `Du bist in Mission ${quiz.code} (${quiz.status === 'lobby' ? 'Lobby' : 'läuft'}).`
    : quiz.status === 'lobby' ? `Mission ${quiz.code} wartet in der Lobby – du kannst ohne Code beitreten.`
    : `Mission ${quiz.code} läuft bereits (Beitritt nur vor dem Start).`;
  const logout = h('button', { type: 'button', class: 'btn btn--ghost' }, 'LOGOUT');
  logout.addEventListener('click', async () => {
    const a = getAccount();
    try { if (a) await rpc('account_logout', { p_token: a.token }); } catch { /* egal */ }
    clearAccount();
    renderAuth('login');
  });

  mount(app,
    h('section', { class: 'card profile' },
      stamp(me.checked_in ? 'ON SITE' : 'STANDBY'),
      h('p', { class: 'eyebrow', text: 'OPERATOR PROFILE' }),
      h('h1', { class: 'title title--xl profile__name', text: me.username }),
      h('p', { class: `profile__status${me.checked_in ? ' is-in' : ''}` },
        h('span', { class: 'led', 'aria-hidden': 'true' }),
        me.checked_in ? 'EINGECHECKT – DU BIST VOR ORT' : 'NOCH NICHT EINGECHECKT – DER COMMANDER CHECKT DICH EIN'),
      returnTo ? h('a', { class: 'btn btn--primary btn--block', href: `./${returnTo}` }, 'WEITER ▸') : null,
      h('div', { class: 'stripes', 'aria-hidden': 'true' })),

    h('section', { class: 'card profile__section' },
      h('p', { class: 'eyebrow', text: '01 // QUIZ' }),
      h('p', { class: 'lead', text: quizText }),
      h('a', { class: `btn btn--block ${quiz && (quiz.joined || quiz.status === 'lobby') ? 'btn--primary' : 'btn--ghost'}`, href: './quiz.html' },
        quiz && quiz.joined ? 'ZUR MISSION ▸' : quiz && quiz.status === 'lobby' ? `ALS ${me.username} BEITRETEN ▸` : 'ZUM QUIZ ▸')),

    h('section', { class: 'card profile__section' },
      h('p', { class: 'eyebrow', text: '02 // GAME COUNTER – MEINE CS-STATS' }),
      me.team.in_roster
        ? h('dl', { class: 'facts facts--stats' },
            statBox('MATCHES', String(t.matches)), statBox('K / D', kd), statBox('KILLS', String(t.kills)),
            statBox('ADR', String(t.adr)), statBox('HS %', `${t.hs} %`), statBox('MVPs', String(t.mvps)))
        : h('p', { class: 'muted', text: 'Du bist (noch) nicht im 5er-Team. Der Commander trägt das Team im Game Counter ein.' }),
      me.team.pending_stats
        ? h('a', { class: 'btn btn--primary btn--block', href: './counter.html' }, `${me.team.pending_stats} ${me.team.pending_stats === 1 ? 'MATCH' : 'MATCHES'} OHNE STATS – JETZT EINTRAGEN ▸`)
        : h('a', { class: 'btn btn--ghost btn--block', href: './counter.html' }, 'ZUM GAME COUNTER ▸')),

    h('section', { class: 'card profile__section' },
      h('p', { class: 'eyebrow', text: '03 // BRACKET' }),
      h('p', { class: 'lead', text: me.tournament.participant ? 'Du bist im 1v1-Turnier eingetragen.' : 'Du bist (noch) nicht im 1v1-Turnier eingetragen.' }),
      h('a', { class: 'btn btn--ghost btn--block', href: './bracket.html' }, 'ZUM BRACKET ▸')),

    h('div', { class: 'card__foot' }, logout));
}

init();
