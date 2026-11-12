const $ = (id) => document.getElementById(id);
const url = $('url'), urlBox = $('urlBox'), urlHint = $('urlHint');
const go = $('go'), goText = $('goText'), form = document.querySelector('.form');
const now = $('now'), thumb = $('thumb'), nowTitle = $('nowTitle'), nowMeta = $('nowMeta');
const bar = document.querySelector('.bar'), fill = $('fill');
const alertBox = $('alert'), logEl = $('log');

const URL_RE = /^https?:\/\/\S+$/i;
const HISTORY_KEY = 'history.v1';
const PREFS_KEY = 'prefs.v1';
const MAX_LOG = 400;

let ready = false;
let busy = false;
let finishedThisRun = 0;
let lastAutoPaste = '';
const logLines = [];

/* ---------- small helpers ---------- */
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const kind = () => document.querySelector('input[name=kind]:checked').value;
const radio = (name) => document.querySelector(`input[name=${name}]:checked`).value;

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

function hint(msg = '', err = false) {
  urlHint.textContent = msg;
  urlHint.classList.toggle('err', err);
  urlBox.classList.toggle('bad', err);
}

function siteName(link) {
  try {
    const h = new URL(link).hostname.replace(/^(www|m)\./, '');
    if (/youtu\.?be/.test(h)) return 'YouTube';
    if (/facebook|fb\.watch/.test(h)) return 'Facebook';
    if (/tiktok/.test(h)) return 'TikTok';
    if (/instagram/.test(h)) return 'Instagram';
    if (/(^|\.)x\.com$|twitter/.test(h)) return 'X';
    return h;
  } catch { return ''; }
}

function describeUrl() {
  const v = url.value.trim();
  $('clear').hidden = !v;
  if (!v) return hint();
  if (!URL_RE.test(v)) return hint('ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://', true);
  const isList = /[?&]list=|\/playlist|\/@[^/]+\/?(videos|shorts)?$/i.test(v);
  hint(`${siteName(v)}${isList ? ' · มีเพลย์ลิสต์ เปิด "โหลดทั้งเพลย์ลิสต์" ได้ถ้าต้องการทุกคลิป' : ''}`);
}

/* ---------- preferences ---------- */
function applyKind() {
  const mp3 = kind() === 'mp3';
  $('videoQ').hidden = mp3;
  $('audioQ').hidden = !mp3;
}
function savePrefs() {
  store.set(PREFS_KEY, { kind: kind(), vq: radio('vq'), aq: radio('aq') });
}
(function loadPrefs() {
  const p = store.get(PREFS_KEY, {});
  for (const [name, val] of [['kind', p.kind], ['vq', p.vq], ['aq', p.aq]]) {
    const el = val && document.querySelector(`input[name=${name}][value="${val}"]`);
    if (el) el.checked = true;
  }
  applyKind();
})();
document.querySelectorAll('input[name=kind], input[name=vq], input[name=aq]').forEach((r) =>
  r.addEventListener('change', () => { applyKind(); savePrefs(); }));

/* ---------- url input ---------- */
url.addEventListener('input', describeUrl);
url.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !busy) start(); });
$('clear').addEventListener('click', () => { url.value = ''; describeUrl(); url.focus(); });
$('paste').addEventListener('click', async () => {
  url.value = (await window.api.paste()).trim();
  describeUrl();
  url.focus();
});

// When the window gets focus with an empty box, pick up a link the user just copied
async function autoPaste() {
  if (busy || url.value.trim()) return;
  const text = (await window.api.paste()).trim();
  if (URL_RE.test(text) && text !== lastAutoPaste) {
    lastAutoPaste = text;
    url.value = text;
    describeUrl();
    urlHint.textContent = `วางลิงก์จากคลิปบอร์ดให้แล้ว · ${siteName(text)}`;
  }
}
window.api.onFocus(autoPaste);

/* ---------- download ---------- */
function setBusy(b) {
  busy = b;
  form.classList.toggle('busy', b);
  go.classList.toggle('stop', b);
  go.querySelector('use').setAttribute('href', b ? '#i-x' : '#i-down');
  goText.textContent = b ? 'ยกเลิก' : 'ดาวน์โหลด';
  go.disabled = !ready;
}

function showError(title, text) {
  $('alertTitle').textContent = title;
  $('alertText').textContent = text;
  logEl.hidden = true;
  $('toggleLog').textContent = 'ดูรายละเอียด';
  $('toggleLog').hidden = logLines.length === 0;
  alertBox.hidden = false;
}

function friendlyError() {
  const err = [...logLines].reverse().find((l) => l.startsWith('ERROR')) || '';
  const rules = [
    [/Unsupported URL/i, 'ไม่รองรับลิงก์นี้', 'ลองตรวจสอบว่าเป็นลิงก์ของคลิปหรือโพสต์โดยตรง'],
    [/Private video|private/i, 'คลิปนี้เป็นแบบส่วนตัว', 'เจ้าของคลิปไม่ได้เปิดให้คนทั่วไปดู'],
    [/unavailable|removed|deleted|not available/i, 'ไม่พบคลิปนี้', 'คลิปอาจถูกลบ หรือไม่เปิดให้ดูในประเทศไทย'],
    [/Sign in|login|cookies|age/i, 'เว็บต้องการให้ล็อกอินก่อน', 'คลิปนี้จำกัดอายุหรือจำกัดเฉพาะสมาชิก จึงโหลดไม่ได้'],
    [/getaddrinfo|Unable to connect|timed out|Connection|network/i, 'เชื่อมต่ออินเทอร์เน็ตไม่ได้', 'ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่อีกครั้ง'],
    [/ffmpeg/i, 'แปลงไฟล์ไม่สำเร็จ', 'ตรวจสอบว่าติดตั้ง ffmpeg แล้ว (winget install ffmpeg)'],
    [/Requested format is not available/i, 'ไม่มีคุณภาพที่เลือก', 'ลองเลือกคุณภาพอื่น'],
  ];
  for (const [re, t, d] of rules) if (re.test(err)) return [t, d];
  return ['ดาวน์โหลดไม่สำเร็จ', err.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') || 'ลองใหม่อีกครั้ง'];
}

function addLog(line) {
  logLines.push(line);
  if (logLines.length > MAX_LOG) logLines.splice(0, logLines.length - MAX_LOG);
}

go.addEventListener('click', () => {
  if (busy) { window.api.cancel(); goText.textContent = 'กำลังยกเลิก…'; go.disabled = true; }
  else start();
});

async function start() {
  const link = url.value.trim();
  if (!link) { hint('วางลิงก์ก่อนนะ', true); url.focus(); return; }
  if (!URL_RE.test(link)) { hint('ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://', true); url.focus(); return; }

  logLines.length = 0;
  finishedThisRun = 0;
  alertBox.hidden = true;
  thumb.style.backgroundImage = '';
  nowTitle.textContent = 'กำลังอ่านข้อมูลลิงก์…';
  nowMeta.textContent = siteName(link);
  fill.style.width = '0';
  bar.classList.add('indeterminate');
  now.hidden = false;

  setBusy(true); // right away: start() may wait for a yt-dlp update first
  const res = await window.api.start({
    url: link, kind: kind(), videoQ: radio('vq'), audioQ: radio('aq'), playlist: $('playlist').checked,
  });
  if (!res.ok) {
    setBusy(false);
    now.hidden = true;
    bar.classList.remove('indeterminate');
    if (res.cancelled) toast('ยกเลิกแล้ว'); else showError('เริ่มดาวน์โหลดไม่ได้', res.error);
  }
}

window.api.onProgress((d) => {
  bar.classList.remove('indeterminate');
  fill.style.width = `${Math.max(0, Math.min(100, d.percent))}%`;
  if (d.title) nowTitle.textContent = d.title;
  if (d.thumb && !thumb.style.backgroundImage.includes(d.thumb)) {
    thumb.style.backgroundImage = `url("${d.thumb.replace(/"/g, '%22')}")`;
  }
  const parts = [`${Math.floor(d.percent)}%`];
  if (d.speed) parts.push(d.speed.replace('iB/s', 'B/s'));
  if (d.eta && d.percent < 100) parts.push(`เหลือ ${d.eta}`);
  if (d.index && d.count) parts.unshift(`คลิป ${d.index} จาก ${d.count}`);
  nowMeta.textContent = parts.join(' · ');
});

window.api.onLog((line) => {
  addLog(line);
  const stage =
    line.includes('[Merger]') ? 'กำลังรวมภาพและเสียง…' :
    line.includes('[ExtractAudio]') ? 'กำลังแปลงเป็น MP3…' :
    line.includes('[EmbedThumbnail]') ? 'กำลังใส่ภาพปก…' : '';
  if (stage) { nowMeta.textContent = stage; bar.classList.add('indeterminate'); }
});

window.api.onFile((f) => {
  finishedThisRun++;
  addHistory({ path: f.path, name: f.name, kind: /\.mp3$/i.test(f.name) ? 'mp3' : 'mp4', at: Date.now() });
});

window.api.onDone(({ ok, cancelled }) => {
  setBusy(false);
  bar.classList.remove('indeterminate');
  now.hidden = true;
  if (cancelled) { toast('ยกเลิกแล้ว'); return; }
  if (ok) {
    toast(finishedThisRun > 1 ? `โหลดเสร็จ ${finishedThisRun} ไฟล์` : 'ดาวน์โหลดเสร็จแล้ว');
    url.value = ''; describeUrl();
    return;
  }
  // partial success in a playlist still counts, but tell the user something failed
  const [t, d] = friendlyError();
  showError(finishedThisRun ? `โหลดได้ ${finishedThisRun} ไฟล์ แต่บางคลิปไม่สำเร็จ` : t, d);
});

$('toggleLog').addEventListener('click', () => {
  logEl.hidden = !logEl.hidden;
  logEl.textContent = logLines.join('\n');
  logEl.scrollTop = logEl.scrollHeight;
  $('toggleLog').textContent = logEl.hidden ? 'ดูรายละเอียด' : 'ซ่อนรายละเอียด';
});

/* ---------- history ---------- */
let history = store.get(HISTORY_KEY, []);

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'เมื่อสักครู่';
  if (s < 3600) return `${Math.floor(s / 60)} นาทีที่แล้ว`;
  if (s < 86400) return `${Math.floor(s / 3600)} ชั่วโมงที่แล้ว`;
  return new Date(ts).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
}

function prettyName(name) {
  return name.replace(/\s*\[[\w-]{6,}\]/, '').replace(/\.(mp3|mp4|webm|mkv|m4a)$/i, '');
}

function iconBtn(icon, title, onClick) {
  const b = document.createElement('button');
  b.className = 'icon-btn'; b.title = title;
  b.innerHTML = `<svg><use href="#${icon}"/></svg>`;
  b.addEventListener('click', onClick);
  return b;
}

async function renderHistory(flashFirst = false) {
  const list = $('history');
  list.textContent = '';
  $('historyWrap').hidden = history.length === 0;
  const exists = history.length ? await window.api.exists(history.map((h) => h.path)) : [];
  history.forEach((h, i) => {
    const li = document.createElement('li');
    if (!exists[i]) li.classList.add('missing');
    if (flashFirst && i === 0) li.classList.add('new');

    const ic = document.createElement('div');
    ic.className = 'h-icon';
    ic.innerHTML = `<svg><use href="#${h.kind === 'mp3' ? 'i-music' : 'i-video'}"/></svg>`;

    const nm = document.createElement('div');
    nm.className = 'h-name';
    const title = document.createElement('div');
    title.textContent = prettyName(h.name);
    title.title = h.name;
    const meta = document.createElement('small');
    const q = (h.name.match(/(\d{3,4}p)\.\w+$/) || [])[1];
    meta.textContent = [h.kind.toUpperCase(), q, exists[i] ? timeAgo(h.at) : 'ไฟล์ถูกย้ายหรือลบแล้ว'].filter(Boolean).join(' · ');
    nm.append(title, meta);

    const act = document.createElement('div');
    act.className = 'h-actions';
    if (exists[i]) {
      act.append(
        iconBtn('i-play', 'เปิดไฟล์', () => window.api.openFile(h.path)),
        iconBtn('i-folder', 'แสดงในโฟลเดอร์', () => window.api.showFile(h.path)),
      );
    }
    li.append(ic, nm, act);
    li.addEventListener('dblclick', () => exists[i] && window.api.openFile(h.path));
    list.append(li);
  });
}

function addHistory(item) {
  history = [item, ...history.filter((h) => h.path !== item.path)].slice(0, 30);
  store.set(HISTORY_KEY, history);
  renderHistory(true);
}

$('clearHistory').addEventListener('click', () => {
  history = []; store.set(HISTORY_KEY, history); renderHistory();
});

/* ---------- footer & init ---------- */
$('folder').addEventListener('click', () => window.api.openFolder());

(async () => {
  const { ytdlp, outDir } = await window.api.init();
  $('outdir').textContent = outDir;
  $('outdir').title = outDir;
  ready = !!ytdlp;
  setBusy(false);
  renderHistory();
  if (!ready) {
    showError('ยังไม่ได้ติดตั้ง yt-dlp', 'เปิด PowerShell แล้วพิมพ์: winget install yt-dlp จากนั้นเปิดโปรแกรมนี้ใหม่');
    $('toggleLog').hidden = true;
  } else {
    url.focus();
    autoPaste();
  }
})();

/* ---------- drop a link onto the window ---------- */
// main blocks the navigation a drop would cause; use the dropped link instead
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (busy) return;
  const text = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split(/\r?\n/)[0].trim();
  if (URL_RE.test(text)) { url.value = text; describeUrl(); url.focus(); }
});
