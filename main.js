const { app, BrowserWindow, ipcMain, shell, clipboard, nativeTheme } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// Installed copy (Setup.exe): saves to the user's Downloads\YTDownloader and uses the bundled
// yt-dlp/ffmpeg from resources\bin. Dev copy (npm start): saves next to the code, tools from PATH.
const OUT_DIR = app.isPackaged ? path.join(app.getPath('downloads'), 'YTDownloader') : path.join(__dirname, 'Downloads');
const BIN_DIR = app.isPackaged ? path.join(process.resourcesPath, 'bin') : null;
const PAGE_URL = pathToFileURL(path.join(__dirname, 'index.html')).href;
const PROG = '@@PROG|';
const DONE = '@@DONE|';
const URL_RE = /^https?:\/\/\S+$/i;
const MEDIA_EXT = /\.(mp3|mp4|m4a|webm|mkv|mov|opus|ogg|aac|flac|wav)$/i;

// Only real media files inside OUT_DIR may be opened, revealed or probed from the page.
// Guards against a fake path (e.g. an injected "@@DONE|C:\...\evil.exe" line) reaching shell.openPath.
function safeMediaPath(p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || !MEDIA_EXT.test(p)) return null;
  const inside = (abs, root) => {
    const rel = path.relative(root, abs);
    return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  try {
    const real = fs.realpathSync(path.resolve(p)); // resolves symlinks/junctions
    return inside(real, fs.realpathSync(OUT_DIR)) ? real : null;
  } catch { return null; }
}

let win = null;
let child = null;
let cancelled = false;

function findYtDlp() {
  for (const dir of [BIN_DIR, __dirname]) {
    const p = dir && path.join(dir, 'yt-dlp.exe');
    if (p && fs.existsSync(p)) return p;
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'yt-dlp.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function buildArgs({ url, kind, videoQ, audioQ, playlist }) {
  // MP4 names carry the resolution so the same clip can be saved in several qualities
  const name = kind === 'mp3' ? '%(title)s [%(id)s].%(ext)s' : '%(title)s [%(id)s] %(height)sp.%(ext)s';
  const a = [
    '--newline', '--no-colors',
    '--progress-template',
    `download:${PROG}%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(info.playlist_index)s|%(info.n_entries)s|%(info.thumbnail)s|%(info.title)s`,
    // report the final file path once post-processing is finished
    '--no-simulate', '--no-quiet', '-O', `after_move:${DONE}%(filepath)s`,
    '-N', '8',
    '--windows-filenames', '--no-mtime',
    '-P', OUT_DIR,
  ];
  if (BIN_DIR && fs.existsSync(path.join(BIN_DIR, 'ffmpeg.exe'))) a.push('--ffmpeg-location', BIN_DIR);

  if (playlist) {
    a.push('--yes-playlist', '-o',
      // "." fallback keeps single videos directly in OUT_DIR (an empty folder would resolve to the drive root)
      `%(playlist_title|.)s/%(playlist_index&{:03d} - |)s${name}`);
  } else {
    a.push('--no-playlist', '-o', name);
  }

  if (kind === 'mp3') {
    const q = { '128': '128K', '192': '192K', '320': '320K' }[audioQ] || '320K';
    a.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', q,
      '--embed-thumbnail', '--add-metadata');
  } else {
    // Pick the highest resolution up to the limit, then prefer H.264 + AAC so the MP4 plays everywhere
    const h = parseInt(videoQ, 10);
    const sort = Number.isFinite(h) ? `res:${h},vcodec:h264,acodec:aac` : 'res,vcodec:h264,acodec:aac';
    a.push('-f', 'bv*+ba/b', '-S', sort, '--merge-output-format', 'mp4');
  }

  a.push('--', url.trim());
  return a;
}

function send(ch, data) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data);
}

function lineReader(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.search(/\r?\n/)) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(buf[i] === '\r' ? i + 2 : i + 1);
      if (line.trim()) onLine(line);
    }
  });
  stream.on('end', () => { if (buf.trim()) onLine(buf); });
}

const clean = (s) => (s || '').trim().replace(/^NA$/, '');

function handleLine(line) {
  if (line.startsWith(PROG)) {
    const [pct, speed, eta, index, count, thumb, ...title] = line.slice(PROG.length).split('|');
    send('progress', {
      percent: parseFloat(pct) || 0,
      speed: clean(speed),
      eta: clean(eta),
      index: clean(index),
      count: clean(count),
      thumb: clean(thumb),
      title: clean(title.join('|')),
    });
  } else if (line.startsWith(DONE)) {
    const file = safeMediaPath(line.slice(DONE.length).trim());
    if (file) send('file', { path: file, name: path.basename(file) });
    else send('log', line);
  } else {
    send('log', line);
  }
}

// Delete unfinished pieces (*.part, *.ytdl) left behind after a cancel
function removePartials(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) removePartials(p);
    else if (/\.(part|ytdl)$|\.part-Frag\d+/.test(e.name)) fs.rmSync(p, { force: true });
  }
}

function killTree() {
  if (!child) return;
  cancelled = true;
  spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
}

// Answer only our own page in the main frame — never a page the window was navigated to, or an iframe
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (e.senderFrame !== e.sender.mainFrame || e.senderFrame?.url !== PAGE_URL) {
      throw new Error(`blocked IPC "${channel}" from ${e.senderFrame?.url}`);
    }
    return fn(...args);
  });
}

handle('init', () => ({ ytdlp: findYtDlp(), outDir: OUT_DIR }));
handle('paste', () => clipboard.readText());
handle('open-folder', () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  return shell.openPath(OUT_DIR);
});
handle('open-file', (p) => {
  const file = safeMediaPath(p);
  return file ? shell.openPath(file) : 'missing';
});
handle('show-file', (p) => {
  const file = safeMediaPath(p);
  if (!file) return 'missing';
  shell.showItemInFolder(file);
  return '';
});
handle('exists', (paths) => (Array.isArray(paths) ? paths.slice(0, 100).map((p) => !!safeMediaPath(p)) : []));
// A cancel can arrive while start() is still waiting for the yt-dlp update; remember it
let starting = false;
let cancelWhileStarting = false;
handle('cancel', () => { if (child) killTree(); else if (starting) cancelWhileStarting = true; });

// Sites change often and an old yt-dlp stops working, so the installed copy updates its bundled
// yt-dlp on every launch (yt-dlp -U verifies the download against its signed checksums).
// A brand-new yt-dlp release may be blocked for a while by Windows Smart App Control (unsigned, no
// reputation yet), so keep the last copy that was proven to start as yt-dlp.prev.exe to fall back on.
let updating = null;
const PREV_YTDLP = BIN_DIR && path.join(BIN_DIR, 'yt-dlp.prev.exe');
function selfUpdateYtDlp() {
  const exe = BIN_DIR && path.join(BIN_DIR, 'yt-dlp.exe');
  if (!exe || !fs.existsSync(exe)) return;
  const tmp = `${PREV_YTDLP}.tmp`;
  try { fs.copyFileSync(exe, tmp); } catch {}
  updating = new Promise((resolve) => {
    const p = spawn(exe, ['-U'], { windowsHide: true });
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, 90000);
    p.on('spawn', () => { try { fs.renameSync(tmp, PREV_YTDLP); } catch {} }); // it runs → keep it
    p.on('error', () => { fs.rmSync(tmp, { force: true }); resolve(); });
    p.on('close', () => { clearTimeout(timer); resolve(); });
  }).then(() => { updating = null; });
}

function launch(exe, job, fallback) {
  const c = spawn(exe, buildArgs(job), {
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  child = c;
  let started = false;
  c.on('spawn', () => { started = true; });
  lineReader(c.stdout, handleLine);
  lineReader(c.stderr, (l) => send('log', l));
  c.on('error', (err) => {
    if (started) { send('log', `ERROR: ${err.message}`); return; }
    if (fallback && fs.existsSync(fallback)) {
      send('log', `yt-dlp.exe เปิดไม่ได้ (${err.code}) ใช้ตัวสำรองแทน`);
      launch(fallback, job, null);
      return;
    }
    child = null;
    send('log', `ERROR: เปิด yt-dlp ไม่ได้: ${err.message}`);
    send('done', { ok: false, cancelled: false });
  });
  c.on('close', (code) => {
    if (!started) return;
    child = null;
    if (cancelled) removePartials(OUT_DIR);
    send('done', { ok: code === 0, cancelled });
  });
}

handle('start', async (job) => {
  if (child || starting) return { ok: false, error: 'กำลังดาวน์โหลดอยู่' };
  if (!job || typeof job.url !== 'string' || job.url.length > 4000 || !URL_RE.test(job.url.trim())
      || !['mp3', 'mp4'].includes(job.kind)) {
    return { ok: false, error: 'ลิงก์หรือรูปแบบไฟล์ไม่ถูกต้อง' };
  }
  starting = true;
  cancelWhileStarting = false;
  try { if (updating) await updating; } finally { starting = false; }
  if (cancelWhileStarting) return { ok: false, cancelled: true };
  const exe = findYtDlp();
  if (!exe) return { ok: false, error: 'ไม่พบ yt-dlp' };
  fs.mkdirSync(OUT_DIR, { recursive: true });

  cancelled = false;
  launch(exe, job, PREV_YTDLP);
  return { ok: true };
});

function createWindow() {
  win = new BrowserWindow({
    width: 620,
    height: 860,
    minWidth: 480,
    minHeight: 600,
    title: 'ดาวน์โหลด MP3 / MP4',
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111214' : '#f5f6f8',
    icon: path.join(__dirname, 'icon.ico'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // The window only ever shows index.html: no navigation (e.g. a link or file dropped on it),
  // no popups, no permission prompts (camera, mic, notifications…)
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-redirect', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.once('ready-to-show', () => win.show());
  win.on('focus', () => send('focus'));
  win.loadFile('index.html');
}

app.setAppUserModelId('local.ytdownloader');
app.whenReady().then(() => { selfUpdateYtDlp(); createWindow(); });
app.on('before-quit', killTree);
app.on('window-all-closed', () => app.quit());
