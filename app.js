// Exam Viewer — runs entirely in the browser (Chrome/Edge). Uses the File System
// Access API to read a teacher-chosen folder of student subfolders locally; nothing
// is uploaded. Mirrors the Node poc/ pipeline (extract + render) for the browser.

'use strict';

const $app = document.getElementById('app');
const $topbar = document.getElementById('topbar');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const PART = { a: 'א', b: 'ב', c: 'ג', d: 'ד', e: 'ה' };

let rootHandle = null;          // chosen directory
let students = [];              // [{id, dir, html, meta}]
const modelCache = new Map();   // id -> rendered model (parsed once)

// ---------- tiny IndexedDB (remember last folder handle) ----------
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('exam-viewer', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const saveHandle = (h) => idb('readwrite', (s) => s.put(h, 'dir'));
const loadHandle = () => idb('readonly', (s) => s.get('dir'));

// ---------- file system helpers ----------
async function getDir(handle, ...parts) {
  let h = handle;
  for (const p of parts) { try { h = await h.getDirectoryHandle(p); } catch { return null; } }
  return h;
}
async function getFile(handle, ...parts) {
  const name = parts.pop();
  const d = await getDir(handle, ...parts);
  if (!d) return null;
  try { return await (await d.getFileHandle(name)).getFile(); } catch { return null; }
}
async function listFiles(dir, re) {
  const names = [];
  if (!dir) return names;
  for await (const e of dir.values()) if (e.kind === 'file' && re.test(e.name)) names.push(e.name);
  return names.sort();
}
async function blobFor(dir, name) {
  const f = await (await dir.getFileHandle(name)).getFile();
  return { name, url: URL.createObjectURL(f) };
}

// ---------- parsing (ported from extract.mjs) ----------
const txt = (el) => (el ? el.textContent.replace(/ /g, ' ').replace(/\s+/g, ' ').trim() : '');

function parseItemId(rawId) {
  const id = String(rawId).replace(/^ans_/, '');
  const m = id.match(/^q0*(\d+)(?:([a-z]))?_?(\d+)?/i);
  if (!m) return { num: null, part: null, slot: null, key: id };
  return { num: m[1] ? +m[1] : null, part: m[2] || null, slot: m[3] ? +m[3] : null, key: id };
}

function quickMeta(html) {
  const t = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ');
  const after = (label, re) => { const i = t.indexOf(label); if (i < 0) return ''; const m = t.slice(i + label.length).match(re); return m ? m[0].trim() : ''; };
  return { type: after('סוג הבחינה', /\S[^:]*?(?=\s*מועד|\s*סמל|$)/), code: after('סמל השאלון', /\d{4,}/), term: after('מועד הבחינה', /[^:]+?\d{4}/) };
}

function extractQuestions(doc) {
  const titleByPageId = {};
  doc.querySelectorAll('.pagetitle').forEach(t => { const p = t.getAttribute('pageid'); if (p) titleByPageId[p] = txt(t); });

  const questions = [];
  doc.querySelectorAll('.page').forEach(page => {
    const pageid = page.getAttribute('pageid');
    if (pageid === 'instructions') return;
    const items = [];
    page.querySelectorAll('[id^="ans_"]').forEach(div => {
      const a = txt(div); if (!a) return;
      items.push({ ...parseItemId(div.id), type: 'inplace', answerHtml: div.innerHTML.trim(), answerText: a });
    });
    page.querySelectorAll('select').forEach(sel => {
      const s = txt(sel.querySelector('option[selected]')); if (!s) return;
      items.push({ type: 'cloze', selected: s });
    });
    if (!items.length) return;

    const clone = page.cloneNode(true);
    clone.querySelectorAll('[id^="ans_"], .textarea, .BtnDiv, [type="RecordAnswer"], iframe, script, style, .asset_resize_link, .modal, img').forEach(e => e.remove());
    const promptHtml = clone.innerHTML
      .replace(/\s(width|height)\s*:\s*\d+px/gi, '')
      .replace(/(\s*<br\s*\/?>\s*){3,}/gi, '<br><br>')
      .replace(/(&nbsp;|\s)+/g, ' ').trim();

    const num = (items.find(i => i.num != null) || {}).num ?? null;
    questions.push({ pageid, num, title: titleByPageId[pageid] || null, promptHtml, items });
  });
  questions.sort((a, b) => (a.num ?? 999) - (b.num ?? 999));
  return questions;
}

async function stimulusFor(stdHandle, num, html) {
  const out = { images: [], galleries: [], virtualTour: false };
  if (num == null) return out;
  const myimg = await getDir(stdHandle, 'helpers', 'myimg');
  for (const n of await listFiles(myimg, new RegExp(`^Q0*${num}(-\\d+)?\\.(jpe?g|png|gif)$`, 'i')))
    out.images.push(await blobFor(myimg, n));
  const helpers = await getDir(stdHandle, 'helpers');
  if (helpers) {
    const reGal = new RegExp(`^PhotoGallery_Q0*${num}[a-z]?$`, 'i');
    const galDirs = [];
    for await (const e of helpers.values()) if (e.kind === 'directory' && reGal.test(e.name)) galDirs.push(e);
    galDirs.sort((a, b) => a.name.localeCompare(b.name));
    for (const g of galDirs) {
      const photos = await getDir(g, 'image', 'photos');
      const arr = [];
      for (const n of await listFiles(photos, /\.(jpe?g|png|gif)$/i)) arr.push(await blobFor(photos, n));
      out.galleries.push({ name: g.name, photos: arr });
    }
  }
  if (new RegExp(`VirtualTour_Q0*${num}\\b`, 'i').test(html) && !(await getDir(stdHandle, `VirtualTour_Q${num}`)))
    out.virtualTour = true;
  return out;
}

async function buildModel(student) {
  if (modelCache.has(student.id)) return modelCache.get(student.id);
  const doc = new DOMParser().parseFromString(student.html, 'text/html');
  const stdHandle = await getDir(student.dir, 'standalone_open');
  const questions = extractQuestions(doc);
  for (const q of questions) q.stimulus = await stimulusFor(stdHandle, q.num, student.html);

  try {
    const assetsJs = await getFile(stdHandle, 'answers', 'assets', 'assets.js');
    if (assetsJs) {
      const text = await assetsJs.text();
      const match = text.match(/window\.assetsData\s*=\s*(\{.*\});/s);
      if (match) {
        const assetsData = JSON.parse(match[1]);
        for (const [key, valStr] of Object.entries(assetsData)) {
          const m = key.match(/^q0*(\d+)([a-z])?_asset$/i);
          if (m) {
            const num = +m[1];
            const part = m[2] || null;
            const data = JSON.parse(valStr);
            const q = questions.find(qq => qq.num === num);
            if (q) {
              q.items.push({ type: 'asset', part, key, data });
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn('Could not parse assets.js', e);
  }

  for (const q of questions) {
    q.items.sort((a, b) => {
      const pA = a.part || '';
      const pB = b.part || '';
      if (pA !== pB) return pA.localeCompare(pB);
      return (a.slot || 0) - (b.slot || 0);
    });
  }

  const answered = [...new Set(questions.map(q => q.num).filter(n => n != null))].sort((a, b) => a - b);
  const model = { id: student.id, meta: student.meta, answered, questions };
  modelCache.set(student.id, model);
  return model;
}

// ---------- rendering (ported from build.mjs) ----------
function renderStimulus(s) {
  if (!s) return '';
  const imgs = [...(s.images || []), ...(s.galleries || []).flatMap(g => g.photos || [])];
  const tiles = imgs.map(im =>
    `<a class="thumb" href="${im.url}" target="_blank" title="${esc(im.name)}"><img loading="lazy" src="${im.url}" alt=""></a>`).join('');
  const tour = s.virtualTour
    ? `<div class="missing">חומר הגירוי לשאלה זו הוא סיור וירטואלי (VirtualTour) שאינו כלול בייצוא — לא ניתן להצגה.</div>` : '';
  if (!tiles && !tour) return '';
  return `<div class="stimulus">${tiles ? `<div class="thumbs">${tiles}</div>` : ''}${tour}</div>`;
}
function renderItem(it, q) {
  if (it.type === 'inplace') {
    const tag = it.part ? `${PART[it.part] || it.part}${it.slot ? `(${it.slot})` : ''}` : (it.slot ?? '');
    return `<div class="ans"><div class="ans-tag">${esc(tag)}</div><div class="ans-body">${it.answerHtml || esc(it.answerText)}</div></div>`;
  }
  if (it.type === 'cloze')
    return `<div class="ans cloze"><div class="ans-tag">▾</div><div class="ans-body"><span class="chip">${esc(it.selected)}</span></div></div>`;
  if (it.type === 'asset') {
    const tag = it.part ? `${PART[it.part] || it.part}${it.slot ? `(${it.slot})` : ''}` : (it.slot ?? '');
    let html = '';
    const snaps = it.data.snapshots || [];
    if (snaps.length > 0) {
      html = snaps.map((s, i) => {
        const textHtml = esc(s.text || '').replace(/\n/g, '<br>');
        let imgUrl = null;
        if (q && q.stimulus && q.stimulus.galleries) {
          const filename = s.src ? s.src.split('/').pop() : null;
          if (filename) {
            for (const gal of q.stimulus.galleries) {
              const photo = gal.photos.find(p => p.name === filename);
              if (photo) { imgUrl = photo.url; break; }
            }
          }
        }
        let imgHtml = '';
        if (imgUrl) {
          if (s.zoomRect) {
            const zr = s.zoomRect;
            const bgSize = `${100 / zr.width}% ${100 / zr.height}%`;
            const bgPosX = `${(zr.offsetX / (1 - zr.width)) * 100 || 0}%`;
            const bgPosY = `${(zr.offsetY / (1 - zr.height)) * 100 || 0}%`;
            let aspect = 1;
            if (s.width && s.height) {
              aspect = (zr.width * s.width) / (zr.height * s.height);
            }
            imgHtml = `<div class="snap-crop" style="background-image:url(${imgUrl}); background-size:${bgSize}; background-position:${bgPosX} ${bgPosY}; aspect-ratio:${aspect};"></div>`;
          } else {
            imgHtml = `<img src="${imgUrl}" class="snap-crop" alt=""/>`;
          }
        }
        return `<div class="snap-item">
          ${imgHtml}
          <div class="snap-text">
            <div class="snap-label">תמונה ${i + 1}</div>
            <p>${textHtml}</p>
          </div>
        </div>`;
      }).join('');
    } else {
      html = '<div class="missing">לא צולמו תמונות ביישומון.</div>';
    }
    return `<div class="ans asset"><div class="ans-tag">${esc(tag)}</div><div class="ans-body">
      <div style="margin-bottom:12px"><span class="chip">תשובת יישומון צילום</span></div>
      ${html}
    </div></div>`;
  }
  return '';
}
function renderStudentPage(model) {
  const m = model.meta || {};
  const qs = model.questions.map(q => {
    const title = (q.title || (q.num != null ? 'שאלה ' + q.num : 'שאלה')).replace(/^[\s–—-]+/, '');
    return `
    <section class="q">
      <h3><span class="qbadge">${esc(q.num ?? '✦')}</span><span>${esc(title)}</span></h3>
      ${renderStimulus(q.stimulus)}
      ${q.promptHtml ? `<details class="prompt" open><summary>השאלה</summary><div class="prompt-body">${q.promptHtml}</div></details>` : ''}
      <div class="answers-head">תשובות התלמיד</div>
      ${q.items.map(it => renderItem(it, q)).join('')}
    </section>`;
  }).join('');
  return `
    <a class="backlink" href="#">→ חזרה לרשימת התלמידים</a>
    <header class="exam">
      <div class="label kicker">תיק בחינה</div>
      <h2>תלמיד/ה · ${esc(model.id)}</h2>
      <div class="meta">
        ${m.type ? `<span><b>סוג:</b> ${esc(m.type)}</span>` : ''}
        ${m.term ? `<span><b>מועד:</b> ${esc(m.term)}</span>` : ''}
        ${m.code ? `<span><b>סמל שאלון:</b> ${esc(m.code)}</span>` : ''}
      </div>
      <div class="answered">שאלות שנענו: ${model.answered.join(', ') || '—'}</div>
    </header>
    ${qs || '<p>לא נמצאו תשובות.</p>'}`;
}

// ---------- views ----------
function renderTopbar() {
  if (!rootHandle) { $topbar.innerHTML = ''; return; }
  $topbar.innerHTML = `<div class="row">
    <span class="title">צפייה בבחינות</span>
    <span class="folder-name">📂 ${esc(rootHandle.name)}</span>
    <button id="refresh">רענון</button>
    <button id="change">החלפת תיקייה</button>
  </div>`;
  document.getElementById('refresh').onclick = () => scanAndShow();
  document.getElementById('change').onclick = () => pickFolder();
}

function showWelcome(lastName, errMsg) {
  renderTopbar();
  $app.innerHTML = `
    <div class="welcome">
      <div class="kicker">מערכת צפייה בבחינות בגרות</div>
      <h1>צפייה בתשובות <em>תלמידים</em></h1>
      <p>בחרו את התיקייה שמכילה את תיקיות התלמידים (כל תת-תיקייה נקראת לפי מספר תעודת הזהות של התלמיד). הקבצים נקראים מקומית במחשב שלכם בלבד — שום מידע אינו נשלח לרשת.</p>
      ${lastName ? `<div><button class="primary big" id="resume">פתיחת התיקייה האחרונה · ${esc(lastName)}</button></div><div><button class="ghost" id="pick">בחירת תיקייה אחרת</button></div>`
                 : `<button class="primary big" id="pick">בחירת תיקייה…</button>`}
      ${errMsg ? `<div class="err">${esc(errMsg)}</div>` : ''}
      <div class="hint">דרוש דפדפן Chrome או Edge.</div>
    </div>`;
  const pick = document.getElementById('pick'); if (pick) pick.onclick = () => pickFolder();
  const resume = document.getElementById('resume'); if (resume) resume.onclick = () => resumeFolder();
}

function showNav() {
  renderTopbar();
  const cards = students.map(s => `
    <a class="card" href="#${encodeURIComponent(s.id)}">
      <div class="label">תלמיד/ה</div>
      <div class="sid">${esc(s.id)}</div>
      <div class="sub">${esc(s.meta?.code ? 'שאלון ' + s.meta.code : '')} ${esc(s.meta?.term || '')}</div>
      <div class="go">צפייה בתשובות ←</div>
    </a>`).join('');
  $app.innerHTML = `
    <div class="page-head">
      <div class="kicker">תיקיית הבחינות</div>
      <h1 class="page-h">בחינות תלמידים</h1>
      <p class="lede">${students.length} תלמידים · לחצו על תלמיד כדי לראות את השאלות, התמונות והתשובות.</p>
    </div>
    <div class="grid">${cards || '<div class="empty">לא נמצאו תיקיות תלמידים עם <code>standalone_open</code> בתיקייה שנבחרה.</div>'}</div>`;
}

async function showStudent(id) {
  const student = students.find(s => s.id === id);
  if (!student) { location.hash = ''; return; }
  renderTopbar();
  $app.innerHTML = `<div class="spinner">טוען…</div>`;
  try {
    const model = await buildModel(student);
    $app.innerHTML = renderStudentPage(model);
    document.querySelector('.backlink').onclick = (e) => { e.preventDefault(); location.hash = ''; };
    window.scrollTo(0, 0);
  } catch (e) {
    $app.innerHTML = `<a class="backlink" href="#">← חזרה</a><div class="err">שגיאה בטעינת התלמיד: ${esc(e.message)}</div>`;
    document.querySelector('.backlink').onclick = (ev) => { ev.preventDefault(); location.hash = ''; };
  }
}

// ---------- flow ----------
async function ensurePermission(handle) {
  const opts = { mode: 'read' };
  if (await handle.queryPermission(opts) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

async function scanAndShow() {
  $app.innerHTML = `<div class="spinner">סורק תיקיות…</div>`;
  modelCache.clear();
  students = [];
  try {
    for await (const entry of rootHandle.values()) {
      if (entry.kind !== 'directory') continue;
      const idx = await getFile(entry, 'standalone_open', 'index.html');
      if (!idx) continue;
      const html = await idx.text();
      students.push({ id: entry.name, dir: entry, html, meta: quickMeta(html) });
    }
  } catch (e) {
    showWelcome(rootHandle?.name, `לא ניתן לקרוא את התיקייה: ${e.message}`);
    return;
  }
  students.sort((a, b) => a.id.localeCompare(b.id, 'he', { numeric: true }));
  route();
}

async function pickFolder() {
  if (!window.showDirectoryPicker) {
    showWelcome(null, 'הדפדפן הזה אינו תומך בבחירת תיקייה. השתמשו ב-Chrome או Edge.');
    return;
  }
  try {
    rootHandle = await window.showDirectoryPicker({ id: 'exam-data', mode: 'read' });
  } catch (e) {
    if (e.name === 'AbortError') return; // user cancelled
    showWelcome(null, e.message); return;
  }
  await saveHandle(rootHandle);
  await scanAndShow();
}

async function resumeFolder() {
  try {
    const h = await loadHandle();
    if (!h) return pickFolder();
    if (!(await ensurePermission(h))) { showWelcome(h.name, 'ההרשאה לתיקייה נדחתה.'); return; }
    rootHandle = h;
    await scanAndShow();
  } catch (e) { showWelcome(null, e.message); }
}

function route() {
  if (!rootHandle) return;
  const id = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (id) showStudent(id); else showNav();
}

window.addEventListener('hashchange', route);

(async function init() {
  if (!window.showDirectoryPicker) { showWelcome(null, 'דרוש דפדפן Chrome או Edge (תמיכה בבחירת תיקייה מקומית).'); return; }
  let last = null;
  try { const h = await loadHandle(); if (h) last = h.name; } catch {}
  showWelcome(last);
})();
