const { app, BrowserWindow, shell, Menu, ipcMain, session } = require('electron');
const path = require('path');

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
  try { const u = new URL(url); if (/safelinks/i.test(u.hostname) && u.searchParams.get('url')) return u.searchParams.get('url'); } catch {}
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
  return `(() => {
    const d = ${JSON.stringify(d)};
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
    const fill = (el, v) => { if (!el) return; fields++; if (setVal(el, v)) ok++; };

    const domSel = q(['select#liveDomainBoxList', 'select[name="LiveDomainBoxList"]']);
    const email = q(['#MemberName', '#usernameInput', 'input[name="MemberName"]', 'input[name="Email"]', 'input[type="email"]'])
               || findIn(inputs, /e-?mail|почт|member|username|new email/i);
    if (email) fill(email, domSel ? d.local : d.email);
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
    return { fields, ok };
  })()`;
}

const OUTLOOK_DONE_RE = /^https:\/\/(outlook\.live\.com|outlook\.office\.com|account\.microsoft\.com|www\.microsoft\.com\/[^/]+\/microsoft-365\/outlook)|^https:\/\/login\.live\.com\/ppsecure\/post\.srf/i;

function openOutlookSignup(d) {
  const ses = outlookSession(d.partition);
  const ow = new BrowserWindow({
    width: 1000, height: 860, title: 'Outlook — NexusMail', icon: ICON, autoHideMenuBar: true, backgroundColor: '#ffffff',
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  externalLinks(ow.webContents);
  let done = false, sawFields = false, lastEmpty = 0;
  const finish = () => { if (!done) { done = true; sendOl({ partition: d.partition, stage: 'done' }); } };
  const tick = async () => {
    if (ow.isDestroyed() || done) return;
    try {
      const url = ow.webContents.getURL();
      if (OUTLOOK_DONE_RE.test(url)) return finish();
      const r = await ow.webContents.executeJavaScript(outlookFillScript(d, d.lang));
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

function openOutlookMail(partition) {
  const ses = outlookSession(partition);
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
  mw.loadURL(OUTLOOK_MAIL);
}

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
ipcMain.handle('outlook:open', (_e, partition) => { if (okPartition(partition)) openOutlookMail(partition); return true; });

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
