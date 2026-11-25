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
