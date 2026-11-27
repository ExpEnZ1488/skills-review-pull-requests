const { app, BrowserWindow, shell, Menu, ipcMain, session, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

app.setAppUserModelId('com.nexusmail.app'); // нужно для уведомлений Windows
if (!app.requestSingleInstanceLock()) app.quit();

const ICON = path.join(__dirname, 'build', 'icon.png');
const STEAM_JOIN = 'https://store.steampowered.com/join/';
const isHttp = url => /^https?:\/\//i.test(url);

// Обычный Chrome UA без «Electron/…», чтобы сайты показывали страницу как в браузере
const CHROME_UA = () => app.userAgentFallback.replace(/\s(Electron|NexusMail|nexusmail)\/\S+/gi, '');

let win, steam = null; // steam = { win, partition, data }

function externalLinks(wc) {
  wc.setWindowOpenHandler(({ url }) => { if (isHttp(url)) shell.openExternal(url); return { action: 'deny' }; });
}

function createWindow() {
  win = new BrowserWindow({
    width: 560, height: 920, minWidth: 380, minHeight: 520,
    backgroundColor: '#04060d', title: 'NexusMail', icon: ICON, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  Menu.setApplicationMenu(null);
  externalLinks(win.webContents);
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); if (isHttp(url)) shell.openExternal(url); }
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
}

const STEAM_VERIFY_RE = /^https:\/\/([a-z0-9-]+\.)*(steampowered|steamcommunity)\.com\/.*(newaccountverification|verif)/i;
// Outlook может оборачивать ссылки в safelinks — достаём настоящий адрес
function unwrapLink(url) {
  try { const u = new URL(url); if (/safelinks/i.test(u.hostname) && u.searchParams.get('url')) url = u.searchParams.get('url'); } catch {}
  for (let i = 0; i < 3 && /^https?%3A/i.test(url); i++) { try { url = decodeURIComponent(url); } catch { break; } }
  return url;
}

function sendState(state) { if (win && !win.isDestroyed()) win.webContents.send('steam:state', state); }

// Скрипт автозаполнения внутри страницы Steam. Капчу и галочку согласия пользователь проходит сам.
function fillScript(d, lang) {
  const text = lang === 'en'
    ? 'NexusMail filled in the email and set the country to Ukraine. Tick the agreement, solve the captcha and press Continue. After the email is confirmed, the login and password fields will be filled in automatically.'
    : 'NexusMail вписал почту и выбрал страну Украина. Отметьте согласие, пройдите капчу и нажмите «Продолжить». После подтверждения почты логин и пароль подставятся сами.';
  return `(() => {
    const d = ${JSON.stringify(d)};
    const set = (sel, v) => {
      const el = document.querySelector(sel);
      if (!el || el.value === v || el.dataset.nexusFilled) return;
      el.value = v; el.dataset.nexusFilled = '1';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    };
    set('#email', d.email); set('#reenter_email', d.email);
    // Страна проживания — всегда Украина (UA)
    for (const c of document.querySelectorAll('select#country, select[name="country"], select#country_select')) {
      if (c.dataset.nexusFilled) continue;
      const ua = [...c.options].find(o => o.value === 'UA' || /^(ukraine|украина|україна)$/i.test(o.textContent.trim()));
      if (!ua) continue;
      c.value = ua.value; c.dataset.nexusFilled = '1';
      c.dispatchEvent(new Event('input', { bubbles: true }));
      c.dispatchEvent(new Event('change', { bubbles: true }));
    }
    set('#accountname', d.login); set('#password', d.pass); set('#reenter_password', d.pass);
    if (!document.getElementById('nexus-banner') && document.body) {
      const b = document.createElement('div'); b.id = 'nexus-banner';
      b.textContent = ${JSON.stringify(text)};
      b.style.cssText = 'position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:2147483647;max-width:92%;' +
        'background:#050c1c;color:#00e5ff;border:2px solid #00e5ff;border-radius:10px;padding:10px 16px;' +
        'font:600 14px system-ui,sans-serif;box-shadow:0 0 18px rgba(0,229,255,.5);text-align:center;cursor:pointer';
      b.onclick = () => b.remove();
      document.body.appendChild(b);
    }
    const acc = document.querySelector('#accountname');
    return !!(acc && acc.offsetParent !== null); // шаг 2 виден = почта подтверждена
  })()`;
}

function openSteam(data) {
  if (steam && !steam.win.isDestroyed()) steam.win.close();
  const partition = 'steam-' + Date.now(); // отдельные куки для каждого аккаунта
  session.fromPartition(partition).setUserAgent(CHROME_UA());
  const sw = new BrowserWindow({
    width: 1040, height: 900, title: 'Steam — NexusMail', icon: ICON, autoHideMenuBar: true, backgroundColor: '#171a21',
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  steam = { win: sw, partition, data };
  externalLinks(sw.webContents);

  let stage = '';
  const tick = async () => {
    if (sw.isDestroyed()) return;
    try {
      const atAccountStep = await sw.webContents.executeJavaScript(fillScript(data, data.lang));
      const s = atAccountStep ? 'account' : 'email';
      if (s !== stage) { stage = s; sendState({ stage: s }); }
    } catch {}
  };
  const timer = setInterval(tick, 1500);
  sw.webContents.on('did-finish-load', tick);
  sw.on('closed', () => { clearInterval(timer); if (steam && steam.win === sw) steam = null; sendState({ stage: 'closed' }); });
  sw.loadURL(STEAM_JOIN);
}

// Ссылка подтверждения из письма открывается в той же сессии, что и регистрация
function steamVerify(url) {
  if (!isHttp(url)) return false;
  const partition = steam ? steam.partition : 'steam-verify';
  const vw = new BrowserWindow({
    width: 760, height: 620, title: 'Steam — подтверждение', icon: ICON, autoHideMenuBar: true, backgroundColor: '#171a21',
    parent: steam && !steam.win.isDestroyed() ? steam.win : win,
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  externalLinks(vw.webContents);
  vw.loadURL(url);
  vw.webContents.once('did-finish-load', () => {
    sendState({ stage: 'verified' });
    setTimeout(() => { if (!vw.isDestroyed()) vw.close(); }, 4000);
    if (steam && !steam.win.isDestroyed()) steam.win.focus();
  });
  return true;
}

// ---------- Outlook ----------
const OUTLOOK_SIGNUP = 'https://signup.live.com/signup?lic=1';
const OUTLOOK_MAIL = 'https://outlook.live.com/mail/0/';
const okPartition = p => /^ol-\d{6,}$/.test(String(p || ''));
function sendOl(state) { if (win && !win.isDestroyed()) win.webContents.send('outlook:state', state); }

function outlookSession(partition) {
  const ses = session.fromPartition('persist:' + partition); // вход в почту сохраняется
  ses.setUserAgent(CHROME_UA());
  return ses;
}

// Автозаполнение формы Microsoft. Капчу пользователь проходит сам.
function outlookFillScript(d, lang) {
  const text = lang === 'en'
    ? 'NexusMail fills in the form and presses “Next”. Solve the captcha when it appears.'
    : 'NexusMail заполняет форму и нажимает «Далее». Когда появится капча — пройдите её.';
  return `(async () => {
    const d = ${JSON.stringify(d)};
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const vis = el => el && el.offsetParent !== null && !el.disabled && el.type !== 'hidden';
    const q = sels => { for (const s of sels) for (const el of document.querySelectorAll(s)) if (vis(el)) return el; return null; };
    const meta = el => [el.name, el.id, el.getAttribute('aria-label'), el.placeholder, el.getAttribute('autocomplete'),
                        el.labels && el.labels[0] ? el.labels[0].textContent : ''].join(' ');
    const inputs = [...document.querySelectorAll('input')].filter(vis);
    const selects = [...document.querySelectorAll('select')].filter(vis);
    const findIn = (list, re) => list.find(el => re.test(meta(el)));
    const setVal = (el, v) => {
      if (!el) return false;
      if (el.value === String(v)) return true;
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(v));
      for (const t of ['input', 'change', 'blur']) el.dispatchEvent(new Event(t, { bubbles: true }));
      return el.value === String(v);
    };
    let fields = 0, ok = 0;
    const fill = (el, v) => { if (!el || v === undefined || v === null || v === '') return; fields++; if (setVal(el, v)) ok++; };
    const pageText = (document.body && document.body.innerText) || '';
    // Страница «Добавление адреса электронной почты» (резервная почта для кодов безопасности)
    // Страница «Введите код»
    const boxes = inputs.filter(i => i.maxLength === 1 && /^(tel|text|number)$/.test(i.type));
    const codeInput = q(['input[name="otc"]', '#iOttText', 'input[autocomplete="one-time-code"]', '#idTxtBx_SAOTCC_OTC'])
                   || findIn(inputs.filter(i => i.type !== 'password' && i.type !== 'email'), /\\bcode\\b|введите код|^\\s*код\\b|\\botc\\b/i);
    const codePage = !!codeInput || boxes.length >= 4;
    const proofPage = !codePage && (/proofs\\/add|addproof/i.test(location.href) ||
      /добавлени[ея] адреса электронной почты|оповещения системы безопасности|add (a |an )?(security |recovery )?email|security info|додавання адреси/i.test(pageText));
    let codeFilled = false;

    const domSel = q(['select#liveDomainBoxList', 'select[name="LiveDomainBoxList"]']);
    const email = q(['#MemberName', '#usernameInput', 'input[name="MemberName"]', 'input[name="Email"]', 'input[type="email"]'])
               || findIn(inputs, /e-?mail|почт|member|username|new email/i);
    // Если рядом с полем уже есть домен («@outlook.com» / выпадающий список) — вписываем только имя до @
    const domainText = el => /^@?(outlook|hotmail|live)\.[a-z.]+$/i.test((el.textContent || el.value || '').trim());
    const near = el => { let n = el; for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
      if ([...n.querySelectorAll('span,div,button,label,[role="combobox"],[role="button"],option')].some(x => vis(x) && domainText(x))) return true;
      if (/@(outlook|hotmail|live)\./i.test(n.textContent || '')) return true; } return false; };
    const pickerOnPage = [...document.querySelectorAll('button,[role="combobox"],[role="button"]')].some(x => vis(x) && domainText(x));
    if (codePage) {
      if (d.code && boxes.length >= 4) { fields++; boxes.forEach((b, i) => setVal(b, d.code[i] || '')); ok++; codeFilled = true; }
      else if (d.code && codeInput) { fill(codeInput, d.code); codeFilled = true; }
      else fields++; // кода ещё нет — «Далее» не нажимаем
    } else if (proofPage) {
      if (email && d.recovery) fill(email, d.recovery); else fields++;
    } else if (email) fill(email, (domSel || pickerOnPage || near(email)) ? d.local : d.email);
    if (domSel) { const o = [...domSel.options].find(o => /outlook\.com/i.test(o.value + o.text)); if (o) setVal(domSel, o.value); }

    const pw = inputs.find(i => i.type === 'password');
    if (pw) fill(pw, d.pass);

    fill(q(['#FirstName', '#firstNameInput', 'input[name="FirstName"]']) || findIn(inputs, /first.?name|given|^\s*имя|\bім'я/i), d.first);
    fill(q(['#LastName', '#lastNameInput', 'input[name="LastName"]']) || findIn(inputs, /last.?name|surname|family|фамил|прізвищ/i), d.last);

    const bm = q(['select#BirthMonth', 'select[name="BirthMonth"]']) || findIn(selects, /month|месяц|місяць/i);
    const bd = q(['select#BirthDay', 'select[name="BirthDay"]']) || findIn(selects, /\bday|день/i);
    const by = q(['#BirthYear', 'input[name="BirthYear"]', 'select[name="BirthYear"]']) || findIn(inputs, /year|год|рік/i);
    if (bm) fill(bm, d.bm);
    if (bd) fill(bd, d.bd);
    if (by) fill(by, d.by);

    // Новая страница Microsoft: день и месяц — выпадающие кнопки (role=combobox), а не <select>
    const combos = [...document.querySelectorAll('[role="combobox"]')].filter(vis).filter(c => c.tagName !== 'INPUT' && c.tagName !== 'SELECT');
    const cmeta = c => [c.id, c.getAttribute('name'), c.getAttribute('aria-label'),
      ...(c.getAttribute('aria-labelledby') || '').split(' ').map(id => (document.getElementById(id) || {}).textContent || '')].join(' ');
    const locs = [document.documentElement.lang, navigator.language, 'ru', 'uk', 'en'].filter(Boolean);
    const monthNames = m => locs.flatMap(l => { try { return [new Intl.DateTimeFormat(l, { month: 'long' }).format(new Date(2000, m - 1, 15)).toLowerCase()]; } catch { return []; } });
    const isMonth = (txt, m) => txt === String(m) || txt === String(m).padStart(2, '0') || monthNames(m).some(n => txt.startsWith(n.slice(0, 3)));
    const isDay = (txt, dd) => txt === String(dd) || txt === String(dd).padStart(2, '0');
    const dayBox = combos.find(c => /day|день|дня/i.test(cmeta(c)) && !/month|месяц|місяц/i.test(cmeta(c)));
    const monthBox = combos.find(c => /month|месяц|місяц/i.test(cmeta(c)));
    const pick = async (box, match, idx) => {
      box.click(); await sleep(450);
      const opts = [...document.querySelectorAll('[role="option"]')].filter(vis);
      let o = opts.find(x => match(x.textContent.trim().toLowerCase()));
      if (!o && opts.length) o = opts[Math.min(opts.length - 1, idx)];
      if (o) { o.scrollIntoView({ block: 'center' }); o.click(); await sleep(300); }
      else box.click();
    };
    for (const [box, match, idx] of [[dayBox, t => isDay(t, d.bd), d.bd - 1], [monthBox, t => isMonth(t, d.bm), d.bm - 1]]) {
      if (!box || !d.bd || !d.bm) continue;
      fields++;
      if (!match(box.textContent.trim().toLowerCase())) await pick(box, match, idx);
      if (match(box.textContent.trim().toLowerCase())) ok++;
    }

    const country = q(['select#Country', 'select[name="Country"]', 'select#countryRegionDropdown']) || findIn(selects, /country|region|стран|краї/i);
    if (country && !country.dataset.nx) {
      const o = [...country.options].find(o => o.value === 'UA' || /ukraine|украин|україн/i.test(o.text));
      if (o) { setVal(country, o.value); country.dataset.nx = '1'; }
    }

    if (!document.getElementById('nexus-banner') && document.body) {
      const b = document.createElement('div'); b.id = 'nexus-banner';
      b.textContent = ${JSON.stringify(text)};
      b.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:2147483647;max-width:92%;' +
        'background:#050c1c;color:#00e5ff;border:2px solid #00e5ff;border-radius:10px;padding:10px 16px;' +
        'font:600 14px system-ui,sans-serif;box-shadow:0 0 18px rgba(0,229,255,.5);text-align:center;cursor:pointer';
      b.onclick = () => b.remove();
      document.body.appendChild(b);
    }

    // Всё на шаге заполнено — один раз нажимаем «Далее»
    if (fields && ok === fields) {
      const key = location.pathname + '|' + inputs.concat(selects).map(i => i.name || i.id || i.type).join(',');
      if (window.__nxStep !== key) {
        window.__nxStep = key;
        const btn = q(['#iSignupAction', '#nextButton', 'button[data-testid="primaryButton"]', 'button[type="submit"]', 'input[type="submit"]']);
        if (btn) setTimeout(() => btn.click(), 800);
      }
    }
    // «Не выходить из системы?» — нажимаем «Да»
    if (!fields && /stay signed in|не выходить из системы|залишатися в системі/i.test(pageText) && !window.__nxKmsi) {
      const y = q(['#acceptButton', '#idSIButton9', 'button[data-testid="primaryButton"]', 'input[type="submit"]']);
      if (y) { window.__nxKmsi = 1; setTimeout(() => y.click(), 600); }
    }
    return { fields, ok, proofPage, codePage, codeFilled };
  })()`;
}

const OUTLOOK_DONE_RE = /^https:\/\/(outlook\.live\.com|outlook\.office\.com|account\.microsoft\.com|www\.microsoft\.com\/[^/]+\/microsoft-365\/outlook)|^https:\/\/login\.live\.com\/ppsecure\/post\.srf/i;

// ---------- Резервная почта Gmail: пароль приложения хранится только на этом ПК, зашифрован Windows (DPAPI) ----------
const recoveryFile = () => path.join(app.getPath('userData'), 'recovery.json');
function loadRecovery() {
  try {
    const j = JSON.parse(fs.readFileSync(recoveryFile(), 'utf8'));
    let pass = '';
    if (j.pass && safeStorage.isEncryptionAvailable()) { try { pass = safeStorage.decryptString(Buffer.from(j.pass, 'base64')); } catch {} }
    return { email: String(j.email || ''), pass };
  } catch { return { email: '', pass: '' }; }
}
function saveRecovery(email, pass) {
  const cur = loadRecovery();
  const keep = !pass && cur.email === email ? cur.pass : pass;
  let enc = '';
  if (keep) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('encryption unavailable');
    enc = safeStorage.encryptString(keep).toString('base64');
  }
  fs.writeFileSync(recoveryFile(), JSON.stringify({ email, pass: enc }));
}

async function withImap(cred, fn) {
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: cred.email, pass: cred.pass }, logger: false });
  await client.connect();
  try { return await fn(client); } finally { await client.logout().catch(() => {}); }
}

// Ищем свежий код безопасности Microsoft во «Входящих» и в «Спаме»
async function fetchMsCode(sinceMs, used) {
  if (process.env.NEXUS_FAKE_MS_CODE) return process.env.NEXUS_FAKE_MS_CODE; // для автотестов
  const cred = loadRecovery();
  if (!cred.email || !cred.pass) return null;
  const { simpleParser } = require('mailparser');
  return withImap(cred, async client => {
    const boxes = ['INBOX'];
    try { const junk = (await client.list()).find(b => b.specialUse === '\\Junk'); if (junk) boxes.push(junk.path); } catch {}
    let best = null;
    for (const box of boxes) {
      let lock; try { lock = await client.getMailboxLock(box); } catch { continue; }
      try {
        const uids = (await client.search({ since: new Date(sinceMs - 24 * 3600 * 1000), from: 'microsoft' }, { uid: true })) || [];
        for (const uid of uids.slice(-15)) {
          const msg = await client.fetchOne(uid, { source: true, internalDate: true }, { uid: true });
          const when = msg.internalDate ? new Date(msg.internalDate).getTime() : 0;
          if (when < sinceMs - 90 * 1000) continue;
          const p = await simpleParser(msg.source);
          const text = (p.subject || '') + '\n' + (p.text || '');
          const m = text.match(/(?:security code|code|код безопасности|код)[^0-9]{0,80}(\d{4,8})/i);
          if (m && !used.has(m[1]) && (!best || when > best.when)) best = { code: m[1], when };
        }
      } finally { lock.release(); }
    }
    return best ? best.code : null;
  });
}

// Помощник для страниц Microsoft (вход, резервная почта, код, «не выходить»)
const MS_HOST_RE = /^https:\/\/(signup|login|account)\.live\.com\//i;
async function msAssist(wc, d, st) {
  const url = wc.getURL();
  if (!MS_HOST_RE.test(url)) return null;
  const rec = loadRecovery();
  const r = await wc.executeJavaScript(outlookFillScript({ ...d, recovery: rec.email, code: st.code || '' }, d.lang));
  if (r.proofPage) st.since = Date.now();
  if (r.codePage) {
    if (!st.since) st.since = Date.now() - 3 * 60 * 1000;
    if (r.codeFilled && st.code) { st.used.add(st.code); st.code = ''; }
    const now = Date.now();
    if (!st.code && !st.fetching && (rec.pass || process.env.NEXUS_FAKE_MS_CODE) && now - (st.lastFetch || 0) > 6000) {
      st.fetching = true; st.lastFetch = now;
      fetchMsCode(st.since, st.used).then(c => { if (c) st.code = c; }).catch(e => { st.error = String(e && e.message || e); })
        .finally(() => { st.fetching = false; });
    }
  }
  return r;
}
const newAssistState = () => ({ used: new Set(), code: '', since: 0 });

function openOutlookSignup(d) {
  const ses = outlookSession(d.partition);
  const ow = new BrowserWindow({
    width: 1000, height: 860, title: 'Outlook — NexusMail', icon: ICON, autoHideMenuBar: true, backgroundColor: '#ffffff',
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  externalLinks(ow.webContents);
  let done = false, sawFields = false, lastEmpty = 0;
  const st = newAssistState();
  const finish = () => { if (!done) { done = true; sendOl({ partition: d.partition, stage: 'done' }); } };
  const tick = async () => {
    if (ow.isDestroyed()) return;
    try {
      const url = ow.webContents.getURL();
      if (OUTLOOK_DONE_RE.test(url)) finish();
      const r = await msAssist(ow.webContents, d, st); // и после регистрации — резервная почта, код и т. п.
      if (!r || done) return;
      if (r.fields) sawFields = true;
      // поля закончились, а мы ещё на странице регистрации — значит, сейчас капча
      if (sawFields && !r.fields && ++lastEmpty === 2) sendOl({ partition: d.partition, stage: 'captcha' });
      if (r.fields) lastEmpty = 0;
    } catch {}
  };
  const timer = setInterval(tick, 1500);
  ow.webContents.on('did-finish-load', tick);
  ow.webContents.on('did-navigate', (_e, url) => { if (OUTLOOK_DONE_RE.test(url)) finish(); });
  ow.on('closed', () => { clearInterval(timer); sendOl({ partition: d.partition, stage: done ? 'done' : 'closed' }); });
  ow.loadURL(OUTLOOK_SIGNUP);
}

function openOutlookMail(d) {
  const ses = outlookSession(d.partition);
  const mw = new BrowserWindow({
    width: 1200, height: 860, title: 'Outlook — NexusMail', icon: ICON, autoHideMenuBar: true, backgroundColor: '#ffffff',
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  // ссылка подтверждения Steam из письма -> в окно регистрации Steam, остальное -> в браузер
  mw.webContents.setWindowOpenHandler(({ url }) => {
    const real = unwrapLink(url);
    if (STEAM_VERIFY_RE.test(real)) steamVerify(real);
    else if (isHttp(real)) shell.openExternal(real);
    return { action: 'deny' };
  });
  const st = newAssistState();
  const timer = setInterval(() => { if (!mw.isDestroyed()) msAssist(mw.webContents, d, st).catch(() => {}); }, 1500);
  mw.on('closed', () => clearInterval(timer));
  mw.loadURL(OUTLOOK_MAIL);
}

// Фоновая проверка почты Outlook: находим письмо Steam и сами открываем ссылку подтверждения
const watchers = new Map();
function watchOutlookForSteam(d) {
  const partition = d.partition;
  if (watchers.has(partition)) return;
  const st = newAssistState();
  let msTicks = 0;
  const hw = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { session: outlookSession(partition), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  hw.webContents.setAudioMuted(true);
  const folders = [OUTLOOK_MAIL, 'https://outlook.live.com/mail/0/junkemail'];
  let fi = 0, ticks = 0, finished = false;
  const stop = () => { finished = true; clearInterval(timer); watchers.delete(partition); if (!hw.isDestroyed()) hw.destroy(); };
  const found = url => { if (finished) return; stop(); sendState({ stage: 'mailfound' }); steamVerify(url); };
  hw.webContents.setWindowOpenHandler(({ url }) => { const real = unwrapLink(url); if (STEAM_VERIFY_RE.test(real)) found(real); return { action: 'deny' }; });
  const script = `(() => {
    const unwrap = h => { try { const u = new URL(h); if (/safelinks/i.test(u.hostname) && u.searchParams.get('url')) h = u.searchParams.get('url'); } catch {}
      for (let i = 0; i < 3 && /^https?%3A/i.test(h); i++) { try { h = decodeURIComponent(h); } catch { break; } } return h; };
    const RE = ${STEAM_VERIFY_RE};
    for (const a of document.querySelectorAll('a[href]')) { const h = unwrap(a.href); if (RE.test(h)) return { link: h }; }
    const items = [...document.querySelectorAll('[role="option"], [role="listitem"], [data-convid]')];
    const item = items.find(el => /steam/i.test((el.getAttribute('aria-label') || '') + ' ' + el.textContent));
    if (item) {
      if (!window.__nxClicked || Date.now() - window.__nxClicked > 8000) { window.__nxClicked = Date.now(); item.click(); }
      return { clicked: true };
    }
    if (!window.__nxOther) {
      const b = [...document.querySelectorAll('button, [role="tab"]')].find(x => /^(other|другие|другое|інші)$/i.test(x.textContent.trim()));
      if (b) { window.__nxOther = 1; b.click(); }
    }
    return {};
  })()`;
  const timer = setInterval(async () => {
    if (finished || hw.isDestroyed()) return;
    ticks++;
    if (ticks > 225) { stop(); sendState({ stage: 'mailtimeout' }); return; } // ~15 минут
    if (ticks % 15 === 0) { fi = (fi + 1) % folders.length; hw.loadURL(folders[fi]); return; } // входящие <-> нежелательная
    try {
      // Microsoft просит войти / резервную почту / код — заполняем; если застряли надолго — показываем окно
      const a = await msAssist(hw.webContents, d, st);
      if (a) { if (++msTicks === 12 && !hw.isVisible()) { hw.show(); sendState({ stage: 'mailneedsuser' }); } return; }
      msTicks = 0;
      const r = await hw.webContents.executeJavaScript(script); if (r && r.link) found(r.link);
    } catch {}
  }, 4000);
  watchers.set(partition, stop);
  hw.loadURL(folders[0]);
}
const mailData = x => ({ partition: String(x?.partition || ''), email: String(x?.email || ''), local: String(x?.email || '').split('@')[0],
  pass: String(x?.pass || ''), lang: x?.lang === 'en' ? 'en' : 'ru' });
ipcMain.handle('outlook:watchSteam', (_e, x) => { const d = mailData(x); if (okPartition(d.partition)) watchOutlookForSteam(d); return true; });

ipcMain.handle('recovery:get', () => { const r = loadRecovery(); return { email: r.email, hasPass: !!r.pass }; });
ipcMain.handle('recovery:set', (_e, x) => {
  const email = String(x?.email || '').trim(), pass = String(x?.pass || '').replace(/\s+/g, '');
  try { saveRecovery(email, pass); return { ok: true }; } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('recovery:test', async () => {
  const cred = loadRecovery();
  if (!cred.email || !cred.pass) return { ok: false, error: 'not configured' };
  try { await withImap(cred, async c => { await c.mailboxOpen('INBOX'); }); return { ok: true }; }
  catch (e) { return { ok: false, error: String((e && (e.responseText || e.message)) || e) }; }
});

ipcMain.handle('outlook:signup', (_e, data) => {
  if (!okPartition(data?.partition)) return false;
  const n = v => Math.max(1, Math.min(9999, parseInt(v, 10) || 1));
  openOutlookSignup({
    partition: data.partition, email: String(data.email || ''), local: String(data.local || ''), pass: String(data.pass || ''),
    first: String(data.first || ''), last: String(data.last || ''), bd: n(data.bd), bm: n(data.bm), by: n(data.by),
    lang: data.lang === 'en' ? 'en' : 'ru'
  });
  return true;
});
ipcMain.handle('outlook:open', (_e, x) => { const d = mailData(x); if (okPartition(d.partition)) openOutlookMail(d); return true; });

ipcMain.handle('steam:open', (_e, data) => {
  const clean = {
    email: String(data?.email || ''), login: String(data?.login || ''),
    pass: String(data?.pass || ''), lang: data?.lang === 'en' ? 'en' : 'ru'
  };
  openSteam(clean);
  return true;
});
ipcMain.handle('steam:verify', (_e, url) => steamVerify(String(url || '')));

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
