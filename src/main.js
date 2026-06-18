// Focus — Planner · main.js
// Logique vanilla. Stockage natif via le backend Rust (~/.focus-app/) quand
// l'app tourne dans Tauri ; repli sur localStorage sinon (aperçu navigateur).

// ─── Détection de l'environnement Tauri ──────────────────────────────────────

const TAURI = window.__TAURI__;
const hasTauri = !!(TAURI && TAURI.core);

const invoke = hasTauri ? TAURI.core.invoke : null;
const dialogSave = hasTauri && TAURI.dialog ? TAURI.dialog.save : null;
const fsWriteTextFile = hasTauri && TAURI.fs ? TAURI.fs.writeTextFile : null;
// fetch côté Rust (sans CORS) — requis pour le endpoint token OAuth Google.
const tauriHttpFetch = hasTauri && TAURI.http ? TAURI.http.fetch : null;

// ─── Helpers stockage (backend Rust ou localStorage) ─────────────────────────

async function loadData(key) {
  try {
    if (hasTauri) {
      const val = await invoke('load_data', { key });
      return val ? JSON.parse(val) : null;
    }
    const val = localStorage.getItem('focusapp_' + key);
    return val ? JSON.parse(val) : null;
  } catch { return null; }
}

async function saveData(key, value) {
  try {
    if (hasTauri) {
      await invoke('save_data', { key, value: JSON.stringify(value) });
    } else {
      localStorage.setItem('focusapp_' + key, JSON.stringify(value));
    }
  } catch (e) { console.error('saveData error', e); }
}

// ─── Contrôles fenêtre (feux tricolores) ──────────────────────────────────────

function appWindow() {
  if (TAURI && TAURI.window && TAURI.window.getCurrentWindow) return TAURI.window.getCurrentWindow();
  return null;
}
async function winClose()    { const w = appWindow(); if (w) await w.close(); }
async function winMinimize() { const w = appWindow(); if (w) await w.minimize(); }
async function winMaximize() { const w = appWindow(); if (w) await w.toggleMaximize(); }
window.winClose = winClose;
window.winMinimize = winMinimize;
window.winMaximize = winMaximize;

// Déplacement de la fenêtre via la barre du haut — API Tauri (évite le bug de -webkit-app-region en release).
const dragStrip = document.querySelector('.drag-strip');
if (dragStrip) {
  dragStrip.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const w = appWindow();
    if (w) w.startDragging();
  });
  dragStrip.addEventListener('dblclick', () => {
    const w = appWindow();
    if (w) w.toggleMaximize();
  });
}

// ─── Notification système ─────────────────────────────────────────────────────

async function sysNotify(title, body) {
  if (!hasTauri || !TAURI.notification) return;
  const { sendNotification, isPermissionGranted, requestPermission } = TAURI.notification;
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === 'granted';
    if (granted) sendNotification({ title, body });
  } catch { /* notifications indisponibles */ }
}

// ─── Toast ─────────────────────────────────────────────────────────────────────

function notify(msg, type = 'ok') {
  const n = document.getElementById('notif');
  n.textContent = msg;
  n.classList.toggle('err', type === 'err');
  n.classList.add('show');
  clearTimeout(n._t);
  n._t = setTimeout(() => n.classList.remove('show'), 2600);
}

// ─── Échappement HTML ────────────────────────────────────────────────────────

const esc = str => String(str).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ─── Horloge ─────────────────────────────────────────────────────────────────

function clock() {
  const now = new Date();
  document.getElementById('clock').textContent = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const days = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  document.getElementById('date-chip').textContent = days[now.getDay()] + ' ' + now.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
}
setInterval(clock, 1000);
clock();

// ─── Paramètres / connexions ──────────────────────────────────────────────────

let config = {};

// Palette d'encres (cohérente avec l'esthétique éditoriale) — une teinte par agenda.
const CAL_COLORS = ['#4f6b50', '#b1542f', '#3c577c', '#9a6f2e', '#7a4f6b', '#46756e'];

async function loadConfig() {
  config = (await loadData('config')) || {};
  if (!config.googleOAuth || typeof config.googleOAuth !== 'object') config.googleOAuth = { clientId: '', clientSecret: '' };
  if (!Array.isArray(config.googleAccounts)) config.googleAccounts = [];
  // Nettoyage de l'ancienne approche par clé API (agendas publics), remplacée par OAuth.
  delete config.gcalKey;
  delete config.gcalId;
  delete config.gcalCalendars;
}

/* ---------------- OAuth Google (PKCE) ---------------- */

function b64url(bytes) {
  const b = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

function randState() { return b64url(crypto.getRandomValues(new Uint8Array(16))); }

// Échange/rafraîchissement de jeton — via le plugin http (sans CORS) si dispo.
async function tokenRequest(body) {
  const f = tauriHttpFetch || fetch;
  const r = await f('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return data;
}

async function fetchUserInfo(token) {
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token } });
    const d = await r.json();
    return { email: d.email || '', name: d.name || '' };
  } catch { return { email: '', name: '' }; }
}

async function fetchCalendarList(token) {
  const r = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250&showHidden=true', { headers: { Authorization: 'Bearer ' + token } });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return (d.items || []).map(c => ({ id: c.id, summary: c.summaryOverride || c.summary || c.id, primary: !!c.primary }));
}

// Jeton d'accès valide pour un compte (rafraîchi si expiré).
async function getValidToken(acc) {
  if (acc.accessToken && acc.expiresAt && Date.now() < acc.expiresAt - 60000) return acc.accessToken;
  try {
    const tok = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: acc.refreshToken,
      client_id: config.googleOAuth.clientId,
      client_secret: config.googleOAuth.clientSecret,
    });
    acc.accessToken = tok.access_token;
    acc.expiresAt = Date.now() + (tok.expires_in || 3600) * 1000;
    acc.needsReauth = false;
    return acc.accessToken;
  } catch (e) {
    acc.needsReauth = true;
    const err = new Error(`${acc.email} — reconnexion requise`);
    err._reauth = true;
    throw err;
  }
}

async function connectGoogle(loginHint) {
  const clientId = document.getElementById('goauth-client-id').value.trim();
  const clientSecret = document.getElementById('goauth-client-secret').value.trim();
  if (!clientId || !clientSecret) { notify('Renseignez le Client ID et le secret OAuth.', 'err'); return; }
  if (!hasTauri || !invoke) { notify('La connexion OAuth n\'est disponible que dans l\'app.', 'err'); return; }
  config.googleOAuth = { clientId, clientSecret };
  try {
    const { verifier, challenge } = await pkce();
    const state = randState();
    const scope = 'openid email https://www.googleapis.com/auth/calendar.readonly';
    notify('Ouverture du navigateur…');
    const res = await invoke('google_oauth', { clientId, scope, codeChallenge: challenge, state, loginHint: loginHint || null });
    const tok = await tokenRequest({
      grant_type: 'authorization_code',
      code: res.code,
      code_verifier: verifier,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: res.redirect_uri,
    });
    const { email, name } = await fetchUserInfo(tok.access_token);
    const cals = await fetchCalendarList(tok.access_token);
    const existing = config.googleAccounts.find(a => a.email === email);
    const color = existing?.color || CAL_COLORS[config.googleAccounts.length % CAL_COLORS.length];
    const account = {
      email: email || ('compte-' + (config.googleAccounts.length + 1)),
      name: name || existing?.name || '',
      refreshToken: tok.refresh_token || existing?.refreshToken || '',
      accessToken: tok.access_token,
      expiresAt: Date.now() + (tok.expires_in || 3600) * 1000,
      color,
      needsReauth: false,
      calendars: cals.map(c => ({
        id: c.id,
        summary: c.summary,
        selected: existing ? !!existing.calendars?.find(x => x.id === c.id)?.selected : !!c.primary,
      })),
    };
    if (existing) Object.assign(existing, account); else config.googleAccounts.push(account);
    await saveData('config', config);
    renderAccountsUI();
    notify(`Compte ${account.email} connecté.`);
    fetchCalendar(true);
  } catch (e) {
    notify('Échec de la connexion : ' + e.message, 'err');
  }
}

function reconnectGoogle(email) { connectGoogle(email); }

function disconnectGoogle(email) {
  if (!confirm(`Déconnecter ${email} ?`)) return;
  config.googleAccounts = config.googleAccounts.filter(a => a.email !== email);
  saveData('config', config);
  renderAccountsUI();
  fetchCalendar(true);
}

// Re-récupère la liste des agendas d'un compte (sans reconnexion OAuth), en
// conservant les cases cochées. Utile quand un agenda partagé a été ajouté après coup.
async function refreshCalendars(email) {
  const acc = config.googleAccounts.find(a => a.email === email);
  if (!acc) return;
  try {
    const token = await getValidToken(acc);
    const [info, cals] = await Promise.all([fetchUserInfo(token), fetchCalendarList(token)]);
    if (info.name) acc.name = info.name; // capte le nom complet (pour les libellés OOO)
    acc.calendars = cals.map(c => ({
      id: c.id,
      summary: c.summary,
      selected: !!acc.calendars?.find(x => x.id === c.id)?.selected,
    }));
    await saveData('config', config);
    renderAccountsUI();
    notify(`${cals.length} agenda${cals.length !== 1 ? 's' : ''} pour ${email}.`);
  } catch (e) {
    if (e._reauth) renderAccountsUI();
    notify('Rafraîchissement : ' + e.message, 'err');
  }
}

function toggleCalendar(email, calId, checked) {
  const acc = config.googleAccounts.find(a => a.email === email);
  const cal = acc && acc.calendars.find(c => c.id === calId);
  if (!cal) return;
  cal.selected = checked;
  saveData('config', config);
  fetchCalendar(true);
}

function renderAccountsUI() {
  const c = document.getElementById('gaccounts');
  const accounts = config.googleAccounts || [];
  if (!accounts.length) { c.innerHTML = '<div class="gaccount-empty">Aucun compte connecté.</div>'; return; }
  c.innerHTML = accounts.map(acc => {
    const cals = (acc.calendars || []).map(cal =>
      `<label><input type="checkbox" ${cal.selected ? 'checked' : ''} data-action="toggle-cal" data-email="${esc(acc.email)}" data-cal="${esc(cal.id)}"> ${esc(cal.summary || cal.id)}</label>`
    ).join('') || '<div class="gaccount-empty">Aucun agenda.</div>';
    const reauth = acc.needsReauth ? `<button class="acc-reauth" data-action="reconnect-google" data-email="${esc(acc.email)}">Reconnecter</button>` : '';
    return `<div class="gaccount">
      <div class="gaccount-head"><span class="acc-dot" style="--acc:${esc(acc.color || '')}"></span>
        <span class="acc-mail">${esc(acc.email)}</span>${reauth}
        <button class="acc-refresh" data-action="refresh-cals" data-email="${esc(acc.email)}" title="Rafraîchir les agendas" aria-label="Rafraîchir les agendas"><i class="ti ti-refresh" aria-hidden="true"></i></button>
        <button class="acc-x" data-action="disconnect-google" data-email="${esc(acc.email)}" aria-label="Déconnecter"><i class="ti ti-x" aria-hidden="true"></i></button>
      </div>
      <div class="gaccount-cals">${cals}</div>
    </div>`;
  }).join('');
}
window.connectGoogle = connectGoogle;
window.reconnectGoogle = reconnectGoogle;
window.disconnectGoogle = disconnectGoogle;
window.toggleCalendar = toggleCalendar;

// Remplit le menu déroulant « agenda des congés » avec tous les agendas connectés.
function populateCongesSelect() {
  const sel = document.getElementById('conges-cal');
  const accounts = config.googleAccounts || [];
  const cur = config.congesCalId || '';
  const multi = accounts.length > 1;
  const ids = new Set();
  let html = '<option value="">— Aucun —</option>';
  accounts.forEach(acc => (acc.calendars || []).forEach(cal => {
    ids.add(cal.id);
    const label = multi ? `${cal.summary || cal.id} · ${acc.email}` : (cal.summary || cal.id);
    html += `<option value="${esc(cal.id)}"${cal.id === cur ? ' selected' : ''}>${esc(label)}</option>`;
  }));
  // Valeur enregistrée mais absente de la liste (ancien nom, agenda retiré…) → conservée.
  if (cur && !ids.has(cur)) html += `<option value="${esc(cur)}" selected>${esc(cur)} (introuvable)</option>`;
  sel.innerHTML = html;
}

function openSettings() {
  document.getElementById('goauth-client-id').value = config.googleOAuth?.clientId || '';
  document.getElementById('goauth-client-secret').value = config.googleOAuth?.clientSecret || '';
  renderAccountsUI();
  document.getElementById('notion-token').value = config.notionToken || '';
  document.getElementById('notion-db').value = config.notionDb || '';
  document.getElementById('notion-assignee').value = config.notionAssignee || '';
  document.getElementById('roadmap-db').value = config.roadmapDb || '';
  populateCongesSelect();
  document.getElementById('settings-modal').classList.add('open');
}

function closeSettings() {
  document.getElementById('settings-modal').classList.remove('open');
}

async function saveSettings() {
  config.googleOAuth = {
    clientId: document.getElementById('goauth-client-id').value.trim(),
    clientSecret: document.getElementById('goauth-client-secret').value.trim(),
  };
  config.notionToken = document.getElementById('notion-token').value.trim();
  config.notionDb = document.getElementById('notion-db').value.trim();
  config.notionAssignee = document.getElementById('notion-assignee').value.trim();
  config.roadmapDb = document.getElementById('roadmap-db').value.trim();
  config.congesCalId = document.getElementById('conges-cal').value.trim();
  await saveData('config', config);
  closeSettings();
  notify('Connexions enregistrées.');
  await Promise.all([fetchCalendar(true), fetchNotion(true), fetchRoadmap(true), fetchRoadmapLeaves(true)]);
}

document.getElementById('settings-modal').addEventListener('click', function (e) {
  if (e.target === this) closeSettings();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSettings(); });

// ─── Délégation d'événements (pas de onclick inline — bloqués par le CSP en release) ──
const SIMPLE_ACTIONS = {
  'export': exportData,
  'open-settings': openSettings,
  'close-settings': closeSettings,
  'save-settings': saveSettings,
  'connect-google': () => connectGoogle(),
  'cal-refresh': () => fetchCalendar(true),
  'roadmap-refresh': () => refreshRoadmap(),
  'add-todo': addTodo,
  'pomo-toggle': togglePomo,
  'pomo-prev': pomoPrev,
  'pomo-reset': resetPomo,
  'notes-save': saveNotes,
  'notes-clear': clearNotes,
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'filter') return filterTickets(el.dataset.filter, el);
  if (a === 'toggle-todo') return toggleTodo(+el.dataset.i);
  if (a === 'delete-todo') return deleteTodo(+el.dataset.i);
  if (a === 'reconnect-google') return reconnectGoogle(el.dataset.email);
  if (a === 'refresh-cals') return refreshCalendars(el.dataset.email);
  if (a === 'disconnect-google') return disconnectGoogle(el.dataset.email);
  if (a === 'toggle-cal') return; // géré par l'événement change
  if (SIMPLE_ACTIONS[a]) SIMPLE_ACTIONS[a]();
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-action="toggle-cal"]');
  if (el) toggleCalendar(el.dataset.email, el.dataset.cal, el.checked);
});
document.getElementById('todo-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') addTodo();
});

// ─── Google Calendar ─────────────────────────────────────────────────────────

function evStart(ev) { return new Date(ev.start.dateTime || ev.start.date).getTime(); }

function selectedCalCount() {
  return (config.googleAccounts || []).reduce((n, a) => n + (a.calendars || []).filter(c => c.selected).length, 0);
}

function emptyBox(icon, text, err = false) {
  return `<div class="empty${err ? ' err' : ''}"><div class="e-ico"><i class="ti ${icon}" aria-hidden="true"></i></div><p>${text}</p></div>`;
}

// Événements à masquer : anniversaires, plages « Focus time » et lieux de travail natifs Google.
function isHiddenEvent(ev) {
  return ev.eventType === 'birthday' || ev.eventType === 'focusTime' || ev.eventType === 'workingLocation';
}

function eventHTML(ev) {
  const d = new Date(ev.start.dateTime || ev.start.date);
  const wd = d.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '');
  const timeStr = ev.start.dateTime ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : 'Journée entière';
  // Pastille de source uniquement quand plusieurs agendas sont affichés.
  const multi = selectedCalCount() > 1;
  const src = (multi && (ev._calLabel || ev._calColor))
    ? `<span class="ev-cal" style="--cal:${esc(ev._calColor || '')}">${esc(ev._calLabel || 'Agenda')}</span>` : '';
  return `<div class="event"><div class="ev-date">${esc(wd)}<br>${d.getDate()}</div><div class="ev-main"><div class="ev-title">${esc(ev.summary || 'Sans titre')}</div><div class="ev-time"><i class="ti ti-clock" aria-hidden="true"></i>${esc(timeStr)}${src}</div></div></div>`;
}

// Événements d'un agenda d'un compte (jeton Bearer, rafraîchi au besoin).
async function fetchEventsFor(acc, cal, timeMin, timeMax) {
  const token = await getValidToken(acc); // peut lever { _reauth: true }
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=15`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await r.json();
  if (data.error) throw new Error(`${acc.email} — ${data.error.message}`);
  return (data.items || [])
    .filter(ev => !isHiddenEvent(ev))
    .map(ev => ({ ...ev, _calLabel: cal.summary || cal.id, _calColor: acc.color || '' }));
}

async function fetchCalendar(force = false) {
  const el = document.getElementById('events-list');
  const st = document.getElementById('cal-status');
  const accounts = config.googleAccounts || [];
  const tasks = [];
  accounts.forEach(acc => (acc.calendars || []).forEach(cal => { if (cal.selected) tasks.push({ acc, cal }); }));

  if (!accounts.length) { st.className = 'chip'; st.textContent = 'Non connecté'; return; }
  if (!tasks.length) {
    st.className = 'chip'; st.textContent = 'Aucun agenda';
    el.innerHTML = emptyBox('ti-calendar-plus', 'Cochez au moins un agenda dans Connecter');
    return;
  }

  if (!force) {
    const cached = await loadData('cal_cache');
    if (cached && cached.ts && Date.now() - cached.ts < 5 * 60 * 1000) {
      const shown = (cached.items || []).filter(ev => !isHiddenEvent(ev));
      el.innerHTML = shown.map(eventHTML).join('');
      st.className = 'chip'; st.textContent = `${shown.length} en cache`;
      return;
    }
  }

  const icon = document.getElementById('cal-refresh');
  icon.classList.add('spinning');
  st.className = 'chip'; st.textContent = 'Chargement…';
  try {
    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString();
    const settled = await Promise.allSettled(tasks.map(t => fetchEventsFor(t.acc, t.cal, timeMin, timeMax)));
    const items = [];
    const errors = [];
    let reauthNeeded = false;
    settled.forEach(res => {
      if (res.status === 'fulfilled') items.push(...res.value);
      else { errors.push(res.reason?.message || String(res.reason)); if (res.reason?._reauth) reauthNeeded = true; }
    });
    items.sort((a, b) => evStart(a) - evStart(b));
    await saveData('cal_cache', { items, ts: Date.now() });
    await saveData('config', config); // persiste les jetons rafraîchis / needsReauth
    if (reauthNeeded) renderAccountsUI();

    if (!items.length && errors.length) {
      st.className = 'chip warn'; st.textContent = 'Erreur API';
      el.innerHTML = emptyBox('ti-alert-triangle', esc(errors[0]), true);
      return;
    }
    st.className = errors.length ? 'chip warn' : 'chip ok';
    st.textContent = errors.length
      ? `${items.length} évén · ${errors.length} err`
      : `${items.length} événement${items.length !== 1 ? 's' : ''}`;
    el.innerHTML = items.length ? items.map(eventHTML).join('')
      : emptyBox('ti-calendar-check', 'Aucun événement cette semaine');
  } catch (e) {
    st.className = 'chip warn'; st.textContent = 'Erreur API';
    el.innerHTML = emptyBox('ti-alert-triangle', esc(e.message), true);
  } finally {
    icon.classList.remove('spinning');
  }
}

// ─── Notion ──────────────────────────────────────────────────────────────────

let ticketFilter = 'in-progress';
let allTickets = [];

async function fetchNotion(force = false) {
  const { notionToken, notionDb } = config;
  const el = document.getElementById('tickets-list');
  if (!notionToken || !notionDb) return;

  if (!force) {
    const cached = await loadData('notion_cache');
    if (cached && cached.ts && Date.now() - cached.ts < 5 * 60 * 1000) {
      allTickets = cached.pages;
      renderTickets(allTickets);
      return;
    }
  }

  el.innerHTML = emptyBox('ti-loader-2 spinning', 'Chargement…');
  try {
    // L'API Notion n'autorise pas les appels navigateur (CORS) → on passe par le plugin http (côté Rust).
    const f = tauriHttpFetch || fetch;
    const headers = { 'Authorization': 'Bearer ' + notionToken, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
    // La base peut dépasser 100 lignes → on pagine pour tout récupérer (sinon des tickets sont ratés).
    const results = [];
    let cursor;
    let guard = 0;
    do {
      const body = { page_size: 100, sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }] };
      if (cursor) body.start_cursor = cursor;
      const r = await f(`https://api.notion.com/v1/databases/${notionDb}/query`, { method: 'POST', headers, body: JSON.stringify(body) });
      const data = await r.json();
      if (data.status && data.status >= 400) throw new Error(data.message || 'Erreur Notion');
      results.push(...(data.results || []));
      cursor = data.has_more ? data.next_cursor : null;
      guard++;
    } while (cursor && guard < 20); // plafond de sécurité : 2000 lignes
    console.info(`Notion : ${results.length} tickets récupérés (${guard} page(s))`);
    allTickets = results;
    await saveData('notion_cache', { pages: allTickets, ts: Date.now() });
    renderTickets(allTickets);
  } catch (e) {
    el.innerHTML = emptyBox('ti-alert-triangle', esc(e.message), true);
  }
}

// Catégories affichées (ordre = onglets, compteurs, badges).
const TICKET_CATS = [
  { key: 'in-progress', label: 'En cours', cls: 'prog' },
  { key: 'review', label: 'En review', cls: 'review' },
  { key: 'qa', label: 'En QA', cls: 'qa' },
];
const CAT_META = Object.fromEntries(TICKET_CATS.map(c => [c.key, c]));

// Renvoie la catégorie d'un ticket, ou '' s'il est hors périmètre (à exclure).
function getTicketStatus(props) {
  if (!props) return '';
  const sp = props['État'] || props.Status || props.status || props.Statut || props.Etat;
  if (!sp) return '';
  let val = '';
  if (sp.status) val = (sp.status.name || '').toLowerCase();
  else if (sp.select) val = (sp.select.name || '').toLowerCase();
  else if (sp.rich_text) val = (sp.rich_text[0]?.plain_text || '').toLowerCase();
  if (val.includes('qa')) return 'qa';
  if (val.includes('review') || val.includes('revue')) return 'review';
  if (val.includes('cours') || val.includes('progress') || val.includes('doing')) return 'in-progress';
  return '';
}

// Identifiant lisible du ticket (propriété unique_id, ex. « EVS-91 »).
function ticketRef(props) {
  const u = Object.values(props || {}).find(p => p && p.type === 'unique_id' && p.unique_id);
  if (!u) return '';
  const { prefix, number } = u.unique_id;
  if (number == null) return '';
  return (prefix ? prefix + '-' : '') + number;
}

// Vrai si le ticket est un epic (Type de ticket = « 1. Epic »).
function isEpic(props) {
  const t = props && (props['Type de ticket'] || props.Type);
  const name = t?.select?.name || t?.status?.name || '';
  return /epic/i.test(name);
}

// Vrai si la page a la personne « value » (nom OU ID utilisateur Notion) dans une propriété people.
function pageAssignedTo(page, value) {
  const v = value.trim().toLowerCase();
  const vId = v.replace(/-/g, ''); // UUID sans tirets, pour accepter les deux formats
  const props = page.properties || {};
  return Object.values(props).some(p =>
    p && p.type === 'people' && (p.people || []).some(u =>
      (u.name || '').trim().toLowerCase() === v ||
      (u.id || '').toLowerCase().replace(/-/g, '') === vId
    )
  );
}

function renderTickets(pages) {
  const el = document.getElementById('tickets-list');
  el.innerHTML = '';

  // Filtre « personne assignée » (optionnel) appliqué en amont — nom ou ID utilisateur.
  const assignee = (config.notionAssignee || '').trim();
  let base = assignee ? pages.filter(p => pageAssignedTo(p, assignee)) : pages;
  // On ne garde que les états ciblés (En cours / En review / En QA), hors epics.
  base = base.filter(p => getTicketStatus(p.properties) && !isEpic(p.properties));

  const counts = { 'in-progress': 0, review: 0, qa: 0 };
  base.forEach(p => counts[getTicketStatus(p.properties)]++);
  document.getElementById('notion-stats').innerHTML = TICKET_CATS
    .map(c => `<span class="count ${c.cls}" title="${c.label}">${counts[c.key]}</span>`).join('');

  const filtered = base.filter(p => getTicketStatus(p.properties) === ticketFilter);
  if (!filtered.length) {
    el.innerHTML = emptyBox('ti-checkbox', 'Aucun ticket');
    return;
  }
  filtered.forEach(page => {
    const props = page.properties || {};
    const tp = props.Name || props.Nom || props.Title || Object.values(props).find(p => p.type === 'title');
    const title = tp?.title?.map(t => t.plain_text).join('') || 'Sans titre';
    const ref = ticketRef(props);
    const div = document.createElement('div');
    div.className = 'ticket';
    div.innerHTML = `<div class="tk-title"><span>${esc(title)}${ref ? ` <span class="key">${esc(ref)}</span>` : ''}</span></div>`;
    el.appendChild(div);
  });
}

function filterTickets(f, btn) {
  ticketFilter = f;
  document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderTickets(allTickets);
}
window.filterTickets = filterTickets;
window.fetchCalendar = fetchCalendar;

// ─── Roadmap / Timeline (voile congés) ─────────────────────────────────────────
//
// Barres = epics d'une base Notion DÉDIÉE (config.roadmapDb, même token que les
// tickets), positionnées via la propriété de date « plage » nommée « Date ».
// On ne garde que les projets dont « Ministère » = « Qualité » et qui ont une date.
// Le voile de congés est superposé depuis un agenda Google dédié (fetchRoadmapLeaves).
// Réglages figés (cf. maquette finalisée) : échelle semaine, voile aplat, schéma pastel.

const DAY_MS = 86400000;
const RM_DATE_PROP = 'Date';        // propriété Notion de la plage (début → fin)
const RM_MINISTERE = 'qualité';     // filtre : Ministère = Qualité (insensible casse/accent)

// Statuts Notion réels (option = libellé + emoji) → palette/label de la timeline.
// NO-GO est volontairement exclu de l'affichage (cf. roadmapStatus → 'nogo').
const RM_STATUS = {
  candidats:    { label: 'Candidats',     pal: 'lav'    }, // 🍭
  conception:   { label: 'Conception',    pal: 'sky'    }, // 🌀
  developpement:{ label: 'Développement', pal: 'peach'  }, // 🧨
  done:         { label: 'Done',          pal: 'mint'   }, // 🌱
};
// Renvoie la clé de statut (clé de RM_STATUS), 'nogo' (à exclure) ou '' (inconnu).
function roadmapStatus(props) {
  const sp = props && (props['État'] || props.Status || props.status || props.Statut || props.Etat);
  let val = '';
  if (sp) {
    if (sp.status) val = (sp.status.name || '').toLowerCase();
    else if (sp.select) val = (sp.select.name || '').toLowerCase();
    else if (sp.rich_text) val = (sp.rich_text[0]?.plain_text || '').toLowerCase();
  }
  if (val.includes('no-go') || val.includes('no go') || val.includes('nogo')) return 'nogo';
  if (val.includes('candidat')) return 'candidats';
  if (val.includes('conception')) return 'conception';
  if (val.includes('développement') || val.includes('developpement') || val.includes('dev')) return 'developpement';
  if (val.includes('done') || val.includes('termin') || val.includes('fini')) return 'done';
  return '';
}
// Métadonnées d'un statut, avec repli neutre pour un statut non répertorié.
const statusMeta = key => RM_STATUS[key] || { label: '—', pal: 'butter' };

// Congés du voile, chargés via fetchRoadmapLeaves() (agenda Google). { who, type, start, end }
let roadmapConges = [];

// Palette des personnes (avatars + voile), volontairement distincte des couleurs de statut.
const AV_PALETTE = ['rose', 'teal', 'indigo', 'sand', 'slate'];
// Teintes des bandes de congé par palette (alignées sur les règles CSS .tl-band.band-*).
const BAND_TINT = {
  rose: 'rgba(215,106,147,.18)',
  teal: 'rgba(63,166,158,.18)',
  indigo: 'rgba(111,116,214,.18)',
  sand: 'rgba(176,125,86,.18)',
  slate: 'rgba(107,122,144,.18)',
};
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}
function avatarHTML(name, av, size = 18, showTitle = true) {
  const title = showTitle ? ` title="${esc(name)}"` : '';
  return `<span class="tl-av av-${av}" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px"${title}>${esc(initials(name))}</span>`;
}

// Première personne d'une propriété people, sinon ''.
function pageLead(props) {
  const pp = Object.values(props || {}).find(p => p && p.type === 'people' && (p.people || []).length);
  return pp ? (pp.people[0].name || '') : '';
}
// Titre de la page Notion.
function pageTitle(props) {
  const tp = props.Name || props.Nom || props.Title || Object.values(props || {}).find(p => p && p.type === 'title');
  return tp?.title?.map(t => t.plain_text).join('') || 'Sans titre';
}

const startOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);
const monthLabel = d => d.toLocaleDateString('fr-FR', { month: 'long' }).replace(/^./, c => c.toUpperCase());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = d => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)); };
const fmtDate = d => d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });

// Fenêtre visible = 8 semaines à partir de la semaine en cours ; scroll latéral
// jusqu'à 8 semaines avant (et au-delà à droite pour couvrir la fin des projets).
const RM_VISIBLE_WEEKS = 8;
const RM_BEFORE_WEEKS = 8;
const RM_WEEK_MIN_PX = 96; // largeur de repli si la zone n'est pas mesurable
let roadmapPages = null;   // dernières pages rendues (re-render quand les congés arrivent)
let roadmapSizeObserver = null; // recalcule la largeur du timeline quand la zone visible change

async function fetchRoadmap(force = false) {
  const { notionToken, roadmapDb } = config;
  const body = document.getElementById('roadmap-body');
  if (!notionToken || !roadmapDb) return;

  if (!force) {
    const cached = await loadData('roadmap_cache');
    if (cached && cached.ts && Date.now() - cached.ts < 5 * 60 * 1000) {
      renderRoadmap(cached.pages);
      return;
    }
  }

  body.innerHTML = emptyBox('ti-loader-2 spinning', 'Chargement…');
  try {
    const f = tauriHttpFetch || fetch;
    const headers = { 'Authorization': 'Bearer ' + notionToken, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
    const results = [];
    let cursor, guard = 0;
    do {
      const q = { page_size: 100 };
      if (cursor) q.start_cursor = cursor;
      const r = await f(`https://api.notion.com/v1/databases/${roadmapDb}/query`, { method: 'POST', headers, body: JSON.stringify(q) });
      const data = await r.json();
      if (data.status && data.status >= 400) throw new Error(data.message || 'Erreur Notion');
      results.push(...(data.results || []));
      cursor = data.has_more ? data.next_cursor : null;
      guard++;
    } while (cursor && guard < 20);
    console.info(`Roadmap : ${results.length} pages récupérées (${guard} page(s))`);
    await saveData('roadmap_cache', { pages: results, ts: Date.now() });
    renderRoadmap(results);
  } catch (e) {
    body.innerHTML = emptyBox('ti-alert-triangle', esc(e.message), true);
  }
}

// Extrait {start,end} de la propriété de date « Date ». null si absente.
function readPeriod(props) {
  const p = props && props[RM_DATE_PROP];
  if (!p || p.type !== 'date' || !p.date || !p.date.start) return null;
  const start = new Date(p.date.start);
  const end = p.date.end ? new Date(p.date.end) : new Date(+start + 14 * DAY_MS);
  return { start, end };
}

// Vrai si la propriété « Ministère » vaut « Qualité » (select / status / multi-select).
function isMinistereQualite(props) {
  const m = props && props['Ministère'];
  if (!m) return false;
  const names = [];
  if (m.select) names.push(m.select.name);
  if (m.status) names.push(m.status.name);
  if (m.multi_select) names.push(...m.multi_select.map(o => o.name));
  if (m.rich_text) names.push(m.rich_text.map(t => t.plain_text).join(''));
  return names.some(n => (n || '').toLowerCase().includes(RM_MINISTERE));
}

// Fusionne, par personne, les plages de congés qui se chevauchent, se touchent, ou
// ne sont séparées que par un week-end (jour travaillé = lundi → vendredi).
function mergeLeaves(list) {
  const isWorked = d => { const wd = d.getDay(); return wd >= 1 && wd <= 5; };
  // Vrai s'il existe au moins un jour travaillé strictement entre aEnd et bStart.
  const workedBetween = (aEnd, bStart) => {
    for (let d = addDays(aEnd, 1); d < bStart; d = addDays(d, 1)) if (isWorked(d)) return true;
    return false;
  };
  const byWho = {};
  list.forEach(c => { (byWho[c.who] = byWho[c.who] || []).push(c); });
  const out = [];
  Object.keys(byWho).forEach(who => {
    const items = byWho[who]
      .map(c => ({ who, type: c.type, s: toLocalDate(c.start), e: toLocalDate(c.end) }))
      .sort((a, b) => a.s - b.s);
    let cur = null;
    items.forEach(it => {
      if (cur && !workedBetween(cur.e, it.s)) { if (it.e > cur.e) cur.e = it.e; } // fusion
      else { if (cur) out.push(cur); cur = { ...it }; }
    });
    if (cur) out.push(cur);
  });
  return out.map(c => ({ who: c.who, type: c.type, start: ymd(c.s), end: ymd(c.e) }));
}

function renderRoadmap(pages) {
  roadmapPages = pages; // mémorisé pour re-render quand les congés arrivent
  const body = document.getElementById('roadmap-body');
  const statutsEl = document.getElementById('roadmap-statuts');
  const teamEl = document.getElementById('roadmap-team');
  const rangeEl = document.getElementById('roadmap-range');

  // Légende statuts (statique).
  statutsEl.innerHTML = Object.entries(RM_STATUS)
    .map(([k, s]) => `<span class="tl-leg"><span class="dot st-${s.pal}"></span>${s.label}</span>`).join('');

  // Projets = pages « Ministère = Qualité » ayant une période ; on exclut NO-GO et les sans-date.
  let projects = pages.map(pg => {
    const props = pg.properties || {};
    if (!isMinistereQualite(props)) return null;
    const status = roadmapStatus(props);
    if (status === 'nogo') return null;
    const per = readPeriod(props);
    if (!per) return null;
    return { ref: ticketRef(props), name: pageTitle(props), status, lead: pageLead(props), start: per.start, end: per.end };
  }).filter(Boolean).sort((a, b) => a.start - b.start);

  if (!projects.length) {
    body.innerHTML = emptyBox('ti-timeline', 'Aucun projet « Qualité » daté dans cette base');
    teamEl.innerHTML = '';
    rangeEl.innerHTML = '<i class="ti ti-calendar-month" aria-hidden="true"></i> —';
    return;
  }

  // Fenêtre : début = lundi 8 semaines avant la semaine en cours ;
  // fin = au moins 8 semaines après la semaine en cours, étendue pour couvrir
  // la fin du dernier projet (atteignable par scroll latéral).
  const curMonday = mondayOf(new Date());
  const WIN_START = addDays(curMonday, -RM_BEFORE_WEEKS * 7);
  // On ne garde que les projets atteignables (fin après le bord gauche de la fenêtre).
  projects = projects.filter(p => p.end > WIN_START);
  if (!projects.length) {
    body.innerHTML = emptyBox('ti-timeline', 'Aucun projet « Qualité » sur la période');
    teamEl.innerHTML = '';
    rangeEl.innerHTML = '<i class="ti ti-calendar-month" aria-hidden="true"></i> —';
    return;
  }
  const maxEnd = projects.reduce((m, p) => p.end > m ? p.end : m, projects[0].end);
  let WIN_END = addDays(curMonday, RM_VISIBLE_WEEKS * 7);
  if (maxEnd > WIN_END) WIN_END = mondayOf(addDays(maxEnd, 6)); // arrondi au lundi suivant
  const totalWeeks = Math.round((WIN_END - WIN_START) / (7 * DAY_MS));
  const SPAN = WIN_END - WIN_START;
  const pct = dt => ((dt - WIN_START) / SPAN) * 100;

  // Mois chevauchant la fenêtre (bornés à [WIN_START, WIN_END]).
  const months = [];
  for (let d = startOfMonth(WIN_START); d < WIN_END; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    const ms = new Date(d), me = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    months.push({ label: monthLabel(d), start: ms < WIN_START ? WIN_START : ms, end: me > WIN_END ? WIN_END : me });
  }
  // Lundis de la fenêtre (WIN_START est déjà un lundi).
  const mondays = [];
  for (let d = new Date(WIN_START); d < WIN_END; d = addDays(d, 7)) mondays.push(new Date(d));

  const winLast = addDays(WIN_END, -1);
  const rangeYear = winLast.getFullYear() === WIN_START.getFullYear() ? `${winLast.getFullYear()}` : `${WIN_START.getFullYear()}–${winLast.getFullYear()}`;
  rangeEl.innerHTML = `<i class="ti ti-calendar-month" aria-hidden="true"></i> ${esc(monthLabel(WIN_START))} – ${esc(monthLabel(winLast))} ${rangeYear} · ${RM_VISIBLE_WEEKS} sem. visibles`;

  // Couche grille (semaines + mois forts).
  const gridLayer = mondays.map(m => `<span class="tl-gl" data-l="${pct(m)}"></span>`).join('')
    + months.map(m => `<span class="tl-gl strong" data-l="${pct(m.start)}"></span>`).join('');

  // Congés fusionnés par personne (plages qui se chevauchent, se touchent, ou ne
  // sont séparées que par des jours non travaillés → week-ends et fériés).
  const conges = mergeLeaves(roadmapConges);
  // Couleur unifiée par personne (avatars des barres, voile et légende).
  const people = [...new Set([...projects.map(p => p.lead).filter(Boolean), ...conges.map(c => c.who)])];
  const personAv = Object.fromEntries(people.map((n, i) => [n, AV_PALETTE[i % AV_PALETTE.length]]));

  // Voile congés (aplat) : bandes teintées DERRIÈRE les barres, pastilles AU-DESSUS de tout.
  // Plages identiques (mêmes dates) partagées par plusieurs personnes → un seul tag combiné.
  const congeGroups = {};
  conges.forEach(c => { (congeGroups[`${c.start}|${c.end}`] = congeGroups[`${c.start}|${c.end}`] || []).push(c); });
  const bands = [], caps = [];
  Object.values(congeGroups).forEach(grp => {
    const c = grp[0];
    const cs = toLocalDate(c.start), ce = new Date(+toLocalDate(c.end) + DAY_MS); // fin exclusive
    if (ce <= WIN_START || cs >= WIN_END) return;
    const left = Math.max(0, pct(cs)), width = Math.min(100, pct(ce)) - left;
    const dates = `${fmtDate(cs)} → ${fmtDate(toLocalDate(c.end))}`;
    const firstName = n => n.split(/\s+/)[0];
    if (grp.length === 1) {
      const pal = personAv[c.who] || 'slate';
      bands.push(`<div class="tl-band band-${pal}" data-l="${left}" data-w="${width}"></div>`);
      caps.push(`<div class="tl-band-cap" data-l="${left + width / 2}" title="${esc(`${firstName(c.who)} · ${dates}`)}">${avatarHTML(c.who, pal, 18, false)}</div>`);
    } else {
      // Congé commun : bande en couleurs combinées (dégradé en bandes des couleurs de chacun) + tag combiné.
      const names = grp.map(g => g.who);
      const tints = names.map(n => BAND_TINT[personAv[n] || 'slate'] || BAND_TINT.slate);
      const stops = tints.map((c, i) => `${c} ${(i / tints.length * 100).toFixed(2)}% ${((i + 1) / tints.length * 100).toFixed(2)}%`).join(', ');
      const avs = names.map(n => avatarHTML(n, personAv[n] || 'slate', 18, false)).join('');
      bands.push(`<div class="tl-band" data-l="${left}" data-w="${width}" style="background:linear-gradient(135deg, ${stops})"></div>`);
      caps.push(`<div class="tl-band-cap is-multi" data-l="${left + width / 2}" title="${esc(`${names.map(firstName).join(' & ')} · ${dates}`)}">${avs}</div>`);
    }
  });
  const veil = bands.join(''), veilCaps = caps.join('');

  // Axe : mois + numéros de semaine.
  const axis =
    `<div class="tl-months">${months.map(m => `<div class="tl-mo" data-l="${pct(m.start)}" data-w="${pct(m.end) - pct(m.start)}"><span>${esc(m.label)}</span></div>`).join('')}</div>`
    + `<div class="tl-weeks">${mondays.map(m => `<div class="tl-wk" data-l="${pct(m)}">${m.getDate()}</div>`).join('')}</div>`;

  // Barres projets (tooltip natif au survol : nom complet + dates).
  const tracks = projects.map(p => {
    const s = statusMeta(p.status);
    const left = Math.max(0, pct(p.start)), width = Math.max(0, Math.min(100, pct(p.end)) - left);
    const lead = p.lead ? avatarHTML(p.lead, personAv[p.lead], 18) : '';
    const tip = `${p.name}${p.ref ? ` (${p.ref})` : ''} · ${fmtDate(p.start)} → ${fmtDate(p.end)}`;
    return `<div class="tl-track"><div class="tl-bar st-${s.pal}" data-l="${left}" data-w="${width}" title="${esc(tip)}">${lead}<span class="tl-bar-name">${esc(p.name)}</span>${p.ref ? `<span class="tl-bar-ref">${esc(p.ref)}</span>` : ''}</div></div>`;
  }).join('');

  // Repère « Aujourd'hui » (masqué hors fenêtre).
  const today = new Date();
  const todayMark = (today >= WIN_START && today < WIN_END)
    ? `<div class="tl-today" data-l="${pct(today)}"><span class="tl-today-cap">Aujourd’hui</span></div>` : '';

  body.innerHTML = `<div class="tl-body">
    <div class="tl-scroll">
      <div class="tl-plot">
        <div class="tl-grid-layer">${gridLayer}</div>
        <div class="tl-veil">${veil}</div>
        <div class="tl-axis">${axis}</div>
        <div class="tl-tracks">${tracks}</div>
        ${todayMark}
        <div class="tl-veil-caps">${veilCaps}</div>
      </div>
    </div>
  </div>`;

  // Positionnement en PIXELS, pas en %. Dans la WebView du build (WKWebView via le
  // protocole d'asset), les pourcentages left/right/width des éléments en position:absolute
  // ne se résolvent pas (largeur du bloc conteneur traitée comme indéfinie) → toutes les
  // barres se rabattaient en flux à gauche. En `tauri dev` (servi en http) ça marchait.
  // On calcule donc left/width en px depuis la largeur réelle de la zone visible.
  // Chaque élément positionné porte data-l (% gauche) et, si besoin, data-w (% largeur).
  // ResizeObserver recale au montage et à chaque changement (resize, panneau redevenu visible).
  const scroller = body.querySelector('.tl-scroll');
  const plot = body.querySelector('.tl-plot');
  if (roadmapSizeObserver) roadmapSizeObserver.disconnect();
  if (scroller && plot) {
    let scrolled = false; // on ne cale scrollLeft qu'une fois (sinon saut pendant le défilement)
    const applySize = () => {
      const vw = scroller.clientWidth || RM_VISIBLE_WEEKS * RM_WEEK_MIN_PX; // repli si pas encore mesurable
      const weekW = vw / RM_VISIBLE_WEEKS;
      const plotW = totalWeeks * weekW;
      plot.style.width = plotW + 'px';
      plot.querySelectorAll('[data-l]').forEach(el => {
        el.style.left = (parseFloat(el.dataset.l) / 100 * plotW) + 'px';
        if (el.dataset.w !== undefined) el.style.width = (parseFloat(el.dataset.w) / 100 * plotW) + 'px';
      });
      if (scroller.clientWidth && !scrolled) { scroller.scrollLeft = RM_BEFORE_WEEKS * weekW; scrolled = true; }
    };
    roadmapSizeObserver = new ResizeObserver(applySize);
    roadmapSizeObserver.observe(scroller);
    applySize(); // tentative immédiate si la zone est déjà mesurable
  }

  // Légende équipe : toute personne présente (lead de projet ou en congé), même couleur partout.
  teamEl.innerHTML = people.map(name => `<span class="tl-leg">${avatarHTML(name, personAv[name], 18)} ${esc(name.split(/\s+/)[0])}</span>`).join('');
}

window.fetchRoadmap = fetchRoadmap;

// ─── Congés (voile de la roadmap) — depuis un agenda Google dédié ───────────────
//
// Agenda Google dédié (config.congesCalId = nom ou ID) dont chaque événement est
// une absence, titre « Absence - Prénom Nom ». On réutilise le jeton OAuth Google
// (getValidToken) ; on parse personne + dates → roadmapConges.

// "YYYY-MM-DD" → date locale (évite le décalage UTC) ; sinon Date(dateTime).
function toLocalDate(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(raw);
}
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// « Absence - Prénom Nom » → { who, type, start, end }. Gère les événements journée entière.
function parseLeave(ev) {
  const sum = (ev.summary || '').trim();
  const startRaw = ev.start && (ev.start.date || ev.start.dateTime);
  if (!sum || !startRaw) return null;
  // Convention de l'agenda dédié : « Absence - Prénom Nom » (ou « Congé(s) - … »).
  const m = sum.match(/^\s*(?:absences?|cong[eé]s?)\s*[-–—:]\s*(.+)$/i);
  if (!m) return null; // événement hors-convention → ignoré
  const who = m[1].trim();
  // Fin : pour un événement journée entière, end.date est EXCLUSIVE → dernier jour = -1.
  let end;
  if (ev.end && ev.end.date) end = addDays(toLocalDate(ev.end.date), -1);
  else if (ev.end && ev.end.dateTime) end = new Date(ev.end.dateTime);
  else end = toLocalDate(startRaw);
  return { who, type: 'Absence', start: ymd(toLocalDate(startRaw)), end: ymd(end) };
}

// Email → nom lisible (repli). « alyssa.biot@… » → « Alyssa Biot ».
const humanizeEmail = email => (email || '').split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();

// « Absent du bureau » (OOO Google) → { who, type, start, end }. Si l'absence est celle
// du titulaire du compte, on prend le nom complet du compte (acc.name) plutôt que le
// prénom seul souvent renvoyé par l'organisateur.
function parseOOO(ev, acc) {
  const startRaw = ev.start && (ev.start.date || ev.start.dateTime);
  if (!startRaw) return null;
  const orgEmail = (ev.organizer && ev.organizer.email) || '';
  const isSelf = !orgEmail || orgEmail === acc.email;
  const who = (isSelf && acc.name)
    || (ev.organizer && ev.organizer.displayName)
    || (ev.creator && ev.creator.displayName)
    || acc.name || humanizeEmail(acc.email);
  let end;
  if (ev.end && ev.end.date) end = addDays(toLocalDate(ev.end.date), -1);
  else if (ev.end && ev.end.dateTime) end = new Date(ev.end.dateTime);
  else end = toLocalDate(startRaw);
  return { who, type: 'Absence', start: ymd(toLocalDate(startRaw)), end: ymd(end) };
}

// Événements d'un agenda sur la fenêtre. opts : { eventType, q } (type Google et/ou recherche texte).
async function listCalEvents(calId, token, timeMin, timeMax, opts = {}) {
  let url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`
    + `?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=2500`;
  if (opts.eventType) url += `&eventTypes=${opts.eventType}`;
  if (opts.q) url += `&q=${encodeURIComponent(opts.q)}`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data.items || [];
}
const OOO_RE = /absent\s+du\s+bureau|out of office|hors du bureau/i;
const CONGES_CACHE_V = 2; // bump → invalide l'ancien cache après changement de logique

// Congés du voile = agenda dédié (« Absence - Nom ») + « Absent du bureau » des agendas cochés.
async function fetchRoadmapLeaves(force = false) {
  const calRef = (config.congesCalId || '').trim();
  const accounts = config.googleAccounts || [];
  if (!accounts.length) return;

  if (!force) {
    const cached = await loadData('conges_cache');
    if (cached && cached.v === CONGES_CACHE_V && cached.ts && Date.now() - cached.ts < 30 * 60 * 1000) {
      roadmapConges = cached.conges || [];
      if (roadmapPages) renderRoadmap(roadmapPages);
      return;
    }
  }

  const now = new Date();
  const timeMin = addDays(mondayOf(now), -RM_BEFORE_WEEKS * 7).toISOString();
  const timeMax = addDays(now, 183).toISOString();
  const all = [];
  const errors = [];

  // Source 1 — agenda dédié (ID exact, sinon nom insensible casse/accents).
  if (calRef) {
    const norm = x => (x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const needle = norm(calRef);
    let found = null;
    for (const acc of accounts) {
      for (const cal of (acc.calendars || [])) {
        if (cal.id === calRef || norm(cal.summary).includes(needle)) { found = { acc, cal }; break; }
      }
      if (found) break;
    }
    if (found) {
      try {
        const token = await getValidToken(found.acc);
        const items = await listCalEvents(found.cal.id, token, timeMin, timeMax);
        all.push(...items.map(parseLeave).filter(Boolean));
      } catch (e) { errors.push(e.message || 'agenda dédié'); }
    } else {
      notify('Agenda congés introuvable : « ' + calRef + ' »', 'err');
    }
  }

  // Source 2 — « Absent du bureau » des agendas cochés (module « cette semaine »).
  // On capte le type natif Google (outOfOffice) ET les événements simples titrés « Absent du bureau ».
  for (const acc of accounts) {
    const sels = (acc.calendars || []).filter(c => c.selected);
    if (!sels.length) continue;
    try {
      const token = await getValidToken(acc);
      for (const cal of sels) {
        const [typed, named] = await Promise.all([
          listCalEvents(cal.id, token, timeMin, timeMax, { eventType: 'outOfOffice' }),
          listCalEvents(cal.id, token, timeMin, timeMax, { q: 'absent' }),
        ]);
        const byId = new Map();
        [...typed, ...named].forEach(ev => { if (ev && ev.id) byId.set(ev.id, ev); });
        byId.forEach(ev => {
          if (ev.eventType === 'outOfOffice' || OOO_RE.test(ev.summary || '')) {
            const c = parseOOO(ev, acc);
            if (c) all.push(c);
          }
        });
      }
    } catch (e) { errors.push(e.message || acc.email); }
  }

  // Dédup (personne + dates) puis stockage.
  const seen = new Set();
  roadmapConges = all.filter(c => { const k = `${c.who}|${c.start}|${c.end}`; if (seen.has(k)) return false; seen.add(k); return true; });
  await saveData('conges_cache', { conges: roadmapConges, ts: Date.now(), v: CONGES_CACHE_V });
  await saveData('config', config); // persiste jetons rafraîchis / noms de compte
  console.info(`Congés : ${roadmapConges.length} absence(s)` + (errors.length ? ` · ${errors.length} erreur(s)` : ''));
  if (roadmapPages) renderRoadmap(roadmapPages);
  if (errors.length) notify('Congés : ' + errors[0], 'err');
}
window.fetchRoadmapLeaves = fetchRoadmapLeaves;

// Rafraîchit la feuille de route : epics Notion + congés (Google), avec indicateur de chargement.
async function refreshRoadmap() {
  const ico = document.getElementById('roadmap-refresh-ico');
  if (ico) ico.classList.add('spinning');
  try {
    await Promise.all([fetchRoadmap(true), fetchRoadmapLeaves(true)]);
  } finally {
    if (ico) ico.classList.remove('spinning');
  }
}
window.refreshRoadmap = refreshRoadmap;

// ─── To-do ───────────────────────────────────────────────────────────────────

let todos = [];

async function loadTodos() {
  todos = (await loadData('todos')) || [];
  renderTodos();
}

function renderTodos() {
  const el = document.getElementById('todo-list');
  el.innerHTML = '';
  const remaining = todos.filter(t => !t.done).length;
  document.getElementById('todo-count').textContent = `${remaining}/${todos.length} tâche${todos.length !== 1 ? 's' : ''}`;
  if (!todos.length) { el.innerHTML = emptyBox('ti-coffee', 'Aucune tâche — profitez-en !'); return; }
  todos.forEach((t, i) => {
    const div = document.createElement('div');
    div.className = 'todo-item';
    div.innerHTML = `
      <div class="todo-check${t.done ? ' done' : ''}" data-action="toggle-todo" data-i="${i}" role="checkbox" aria-checked="${t.done}" aria-label="${esc(t.text)}"></div>
      <span class="prio-dot ${t.prio || 'med'}"></span>
      <span class="todo-text${t.done ? ' done' : ''}" data-action="toggle-todo" data-i="${i}">${esc(t.text)}</span>
      <button class="todo-del" data-action="delete-todo" data-i="${i}" aria-label="Supprimer"><i class="ti ti-x" aria-hidden="true"></i></button>`;
    el.appendChild(div);
  });
}

async function addTodo() {
  const inp = document.getElementById('todo-input');
  const prio = document.getElementById('todo-prio').value;
  if (!inp.value.trim()) return;
  todos.unshift({ text: inp.value.trim(), done: false, prio, created: new Date().toISOString() });
  inp.value = '';
  await saveData('todos', todos);
  renderTodos();
}
async function toggleTodo(i) { todos[i].done = !todos[i].done; await saveData('todos', todos); renderTodos(); }
async function deleteTodo(i) { todos.splice(i, 1); await saveData('todos', todos); renderTodos(); }
window.addTodo = addTodo;
window.toggleTodo = toggleTodo;
window.deleteTodo = deleteTodo;

// ─── Pomodoro ────────────────────────────────────────────────────────────────

const POMO_TIMES = { focus: 25 * 60, short: 5 * 60, long: 15 * 60 };
const CIRC = 2 * Math.PI * 80;

let pomoState = { running: false, seconds: 25 * 60, mode: 'focus', total: 0, todaySessions: 0, todayDate: '' };
let pomoInterval = null;

async function loadPomoState() {
  const saved = await loadData('pomo');
  if (saved) {
    pomoState.total = saved.total || 0;
    pomoState.todaySessions = saved.todaySessions || 0;
    pomoState.todayDate = saved.todayDate || '';
    if (pomoState.todayDate !== new Date().toDateString()) {
      pomoState.todaySessions = 0;
      pomoState.todayDate = new Date().toDateString();
    }
  }
  updatePomoUI();
}

function updatePomoUI() {
  const m = String(Math.floor(pomoState.seconds / 60)).padStart(2, '0');
  const s = String(pomoState.seconds % 60).padStart(2, '0');
  document.getElementById('pomo-display').textContent = `${m}:${s}`;
  const total = POMO_TIMES[pomoState.mode];
  const pct = (total - pomoState.seconds) / total;
  const ring = document.getElementById('pomo-ring');
  ring.style.strokeDashoffset = CIRC * (1 - pct);
  ring.style.stroke = pomoState.mode === 'focus' ? 'var(--sky-ink)' : 'var(--mint-ink)';
  const labels = { focus: 'Concentration', short: 'Pause courte', long: 'Pause longue' };
  document.getElementById('pomo-mode-label').textContent = labels[pomoState.mode];
  document.getElementById('pomo-today').textContent = pomoState.todaySessions;
  document.getElementById('pomo-total').textContent = pomoState.total;
  document.getElementById('pomo-mins').textContent = pomoState.total * 25;
  document.getElementById('pomo-session-count').textContent = `${pomoState.total} sessions`;
}

async function savePomo() {
  await saveData('pomo', { total: pomoState.total, todaySessions: pomoState.todaySessions, todayDate: new Date().toDateString() });
}

function togglePomo() {
  if (pomoState.running) {
    clearInterval(pomoInterval);
    pomoState.running = false;
    document.getElementById('pomo-btn').innerHTML = '<i class="ti ti-player-play" aria-hidden="true"></i> Reprendre';
  } else {
    pomoState.running = true;
    document.getElementById('pomo-btn').innerHTML = '<i class="ti ti-player-pause" aria-hidden="true"></i> Pause';
    pomoInterval = setInterval(async () => {
      if (pomoState.seconds > 0) {
        pomoState.seconds--;
        updatePomoUI();
      } else {
        clearInterval(pomoInterval);
        pomoState.running = false;
        if (pomoState.mode === 'focus') {
          pomoState.total++;
          pomoState.todaySessions++;
          await savePomo();
          notify('Session terminée. Prenez une pause.');
          sysNotify('Focus', 'Session Pomodoro terminée — pause méritée.');
          pomoState.mode = 'short';
        } else {
          notify('Pause terminée — c\'est reparti.');
          sysNotify('Focus', 'Pause terminée — retour à la concentration.');
          pomoState.mode = 'focus';
        }
        pomoState.seconds = POMO_TIMES[pomoState.mode];
        document.getElementById('pomo-btn').innerHTML = '<i class="ti ti-player-play" aria-hidden="true"></i> Démarrer';
        updatePomoUI();
      }
    }, 1000);
  }
}

function resetPomo() {
  clearInterval(pomoInterval);
  pomoState.running = false;
  pomoState.seconds = POMO_TIMES[pomoState.mode];
  document.getElementById('pomo-btn').innerHTML = '<i class="ti ti-player-play" aria-hidden="true"></i> Démarrer';
  updatePomoUI();
}

function pomoPrev() {
  clearInterval(pomoInterval);
  pomoState.running = false;
  const modes = ['focus', 'short', 'long'];
  const i = modes.indexOf(pomoState.mode);
  pomoState.mode = modes[(i + 2) % 3];
  pomoState.seconds = POMO_TIMES[pomoState.mode];
  document.getElementById('pomo-btn').innerHTML = '<i class="ti ti-player-play" aria-hidden="true"></i> Démarrer';
  updatePomoUI();
}
window.togglePomo = togglePomo;
window.resetPomo = resetPomo;
window.pomoPrev = pomoPrev;

// ─── Notes ───────────────────────────────────────────────────────────────────

const notesEl = document.getElementById('notes');

async function loadNotes() {
  notesEl.value = (await loadData('notes')) || '';
}

function saveNotes() {
  saveData('notes', notesEl.value);
  document.getElementById('notes-saved').innerHTML =
    '<i class="ti ti-check" aria-hidden="true"></i> Enregistré à ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  notify('Notes enregistrées.');
}

function clearNotes() {
  if (!confirm('Effacer toutes les notes ?')) return;
  notesEl.value = '';
  saveData('notes', '');
  document.getElementById('notes-saved').textContent = '';
}

notesEl.addEventListener('input', () => { document.getElementById('notes-saved').textContent = ''; });
notesEl.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveNotes(); } });
window.saveNotes = saveNotes;
window.clearNotes = clearNotes;

// ─── Export ──────────────────────────────────────────────────────────────────

async function exportData() {
  const calCache = await loadData('cal_cache');
  const notionCache = await loadData('notion_cache');
  const data = {
    exported_at: new Date().toISOString(),
    todos,
    notes: notesEl.value,
    google_calendar_events: calCache?.items || [],
    notion_tickets: notionCache?.pages || [],
    pomodoro_stats: { total_sessions: pomoState.total, total_minutes: pomoState.total * 25 },
  };
  const json = JSON.stringify(data, null, 2);
  const filename = `focus-export-${new Date().toISOString().slice(0, 10)}.json`;

  try {
    if (dialogSave && fsWriteTextFile) {
      const filePath = await dialogSave({ defaultPath: filename, filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (!filePath) return;
      await fsWriteTextFile(filePath, json);
      notify('Export enregistré.');
    } else {
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      notify('Export téléchargé.');
    }
  } catch (e) {
    notify('Erreur export : ' + e.message, 'err');
  }
}
window.exportData = exportData;
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.saveSettings = saveSettings;

// ─── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  await loadConfig();
  await Promise.all([loadTodos(), loadPomoState(), loadNotes()]);

  const calCached = await loadData('cal_cache');
  if (calCached && calCached.items && calCached.items.length) {
    const shown = calCached.items.filter(ev => !isHiddenEvent(ev));
    document.getElementById('events-list').innerHTML = shown.map(eventHTML).join('');
    const st = document.getElementById('cal-status');
    st.className = 'chip'; st.textContent = `${shown.length} en cache`;
  }
  const notionCached = await loadData('notion_cache');
  if (notionCached && notionCached.pages) { allTickets = notionCached.pages; renderTickets(allTickets); }

  const congesCached = await loadData('conges_cache');
  if (congesCached && congesCached.conges) roadmapConges = congesCached.conges;
  const roadmapCached = await loadData('roadmap_cache');
  if (roadmapCached && roadmapCached.pages) renderRoadmap(roadmapCached.pages);

  if (config.googleAccounts.length) fetchCalendar();
  if (config.notionToken) fetchNotion();
  if (config.notionToken && config.roadmapDb) fetchRoadmap();
  if (config.googleAccounts.length) fetchRoadmapLeaves();
}

init();
