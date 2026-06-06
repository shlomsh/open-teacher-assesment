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

// ---------- tiny IndexedDB (remember last folder handle & grading data) ----------
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
const saveKv = (key, val) => idb('readwrite', (s) => s.put(val, key));
const loadKv = (key) => idb('readonly', (s) => s.get(key));
const getAllKv = () => new Promise((resolve) => {
  idb('readonly', s => {
    const r1 = s.getAllKeys();
    const r2 = s.getAll();
    r1.onsuccess = () => {
      r2.onsuccess = () => {
        const obj = {};
        for(let i=0; i<r1.result.length; i++) obj[r1.result[i]] = r2.result[i];
        resolve(obj);
      }
    }
  });
});

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
    
    let maxPoints = null;
    const titleText = titleByPageId[pageid] || '';
    const plainPrompt = promptHtml.replace(/<[^>]+>/g, ' ');
    const pointsMatch = titleText.match(/(\d+)\s*(?:נקודות|נק'|נק\b)/) || plainPrompt.match(/(\d+)\s*(?:נקודות|נק'|נק\b)/);
    if (pointsMatch) maxPoints = parseInt(pointsMatch[1], 10);

    questions.push({ pageid, num, title: titleByPageId[pageid] || null, promptHtml, items, maxPoints });
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
  
  // load grading data
  const examId = rootHandle.name;
  for (const q of questions) {
    if (q.num == null) continue;
    const override = await loadKv(`override_${examId}_${q.num}`);
    q.overridePoints = override ?? null;
    q.grade = await loadKv(`grade_${examId}_${student.id}_${q.num}`) || '';
    q.comment = await loadKv(`comment_${examId}_${student.id}_${q.num}`) || '';
  }

  const model = { id: student.id, meta: student.meta, answered, questions, examId };
  modelCache.set(student.id, model);
  return model;
}

// ---------- export logic ----------
async function exportCsv() {
  if (!rootHandle) return;
  const examId = rootHandle.name;
  const data = await getAllKv();
  let csv = '\\uFEFF"Student ID","Question","Grade","Comment"\\n';
  const rows = [];
  
  const studentIds = new Set();
  const qNums = new Set();
  for (const [k, v] of Object.entries(data)) {
    const mGrade = k.match(/^grade_(.+)_(.+)_(.+)$/);
    if (mGrade && mGrade[1] === examId) { studentIds.add(mGrade[2]); qNums.add(mGrade[3]); }
    const mComment = k.match(/^comment_(.+)_(.+)_(.+)$/);
    if (mComment && mComment[1] === examId) { studentIds.add(mComment[2]); qNums.add(mComment[3]); }
  }

  for (const sid of [...studentIds].sort()) {
    for (const qn of [...qNums].sort((a,b)=>a-b)) {
      const g = data[`grade_${examId}_${sid}_${qn}`] || '';
      const c = data[`comment_${examId}_${sid}_${qn}`] || '';
      if (g !== '' || c !== '') {
        const escCsv = s => '"' + String(s).replace(/"/g, '""') + '"';
        rows.push([escCsv(sid), escCsv(qn), escCsv(g), escCsv(c)].join(','));
      }
    }
  }

  if (!rows.length) return alert('אין ציונים לייצא בתיקייה זו.');
  
  csv += rows.join('\\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `grades_${examId}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ---------- rendering (ported from build.mjs) ----------
function renderStimulus(s) {
  if (!s) return '';
  // Only use gallery photos if there are no main images (to prevent duplicates)
  let imgs = s.images || [];
  if (imgs.length === 0) {
    imgs = (s.galleries || []).flatMap(g => g.photos || []);
  }
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
  const examId = model.examId;
  const qs = model.questions.map(q => {
    const title = (q.title || (q.num != null ? 'שאלה ' + q.num : 'שאלה')).replace(/^[\s–—-]+/, '');
    const maxP = q.overridePoints ?? q.maxPoints;
    return `
    <section class="q" data-qnum="${q.num}">
      <div class="q-header">
        <h3><span class="qbadge">${esc(q.num ?? '✦')}</span><span>${esc(title)}</span></h3>
        <div class="q-points" title="לחצו לעריכת הניקוד המרבי">
          <input type="number" class="override-points" value="${maxP !== null ? maxP : ''}" placeholder="—" data-qnum="${q.num}" />
          <label>נק'</label>
        </div>
      </div>
      ${renderStimulus(q.stimulus)}
      ${q.promptHtml ? `<details class="prompt" open><summary>השאלה</summary><div class="prompt-body">${q.promptHtml}</div></details>` : ''}
      <div class="answers-head">תשובות התלמיד</div>
      ${q.items.map(it => renderItem(it, q)).join('')}
      
      <div class="grading-panel">
        <div class="grading-head">הערכת מורה</div>
        <div class="grading-fields">
          <div class="grading-grade">
            <label>ציון:</label>
            <input type="number" class="grade-input" data-qnum="${q.num}" value="${esc(q.grade)}" min="0" max="${maxP !== null ? maxP : ''}" placeholder="0" />
          </div>
          <div class="grading-comment">
            <label>הערה:</label>
            <input type="text" class="comment-input" data-qnum="${q.num}" value="${esc(q.comment)}" placeholder="פירוט ונימוק..." />
          </div>
        </div>
      </div>
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
    <span class="title">Open Teacher Assessment</span>
    <span class="folder-name">📂 ${esc(rootHandle.name)}</span>
    <button id="export-csv" class="ghost">ייצוא ציונים (CSV)</button>
    <button id="refresh">רענון</button>
    <button id="change">החלפת תיקייה</button>
  </div>`;
  document.getElementById('refresh').onclick = () => scanAndShow();
  document.getElementById('change').onclick = () => pickFolder();
  document.getElementById('export-csv').onclick = () => exportCsv();
}

function showWelcome(lastName, errMsg) {
  renderTopbar();
  $app.innerHTML = `
    <div class="welcome">
      <h1 dir="ltr">Open Teacher <em>Assessment</em></h1>
      <div class="hero-subtitle">מערכת פשוטה ומאובטחת לצפייה בבחינות הדמייה ובדיקתן באופן מקומי.</div>
      
      <div class="cta-group">
        ${lastName ? `<button class="primary big" id="resume">פתיחת התיקייה האחרונה · ${esc(lastName)}</button><button class="ghost" id="pick">בחירת תיקייה אחרת</button>`
                   : `<button class="primary big" id="pick">בחירת תיקייה להתחלה…</button>`}
      </div>

      <div class="welcome-footer">
        <div class="footer-col steps">
          <h3>📖 איך מתחילים?</h3>
          <ol>
            <li>ודאו שאתם משתמשים בדפדפן <strong>Chrome</strong> או <strong>Edge</strong>.</li>
            <li>היכנסו למערכת ה-<strong>iTest</strong> (המערכת הישנה) והורידו את נתוני הבחינות (או קבלו אותם מ<strong>אחראי התקשוב / טכנאי המחשבים</strong>).</li>
            <li>שמרו את הנתונים במחשב. יש לוודא שהנתונים חולצו כך ש<strong>לכל תלמיד יש תיקייה נפרדת</strong> (תעודת זהות).</li>
            <li>לחצו על הכפתור למעלה ובחרו את התיקייה הראשית שמכילה את תיקיות התלמידים.</li>
          </ol>
        </div>
        <div class="footer-col security">
          <h3>🛡️ קוד פתוח ואבטחה</h3>
          <p>פרויקט <strong>קוד פתוח</strong>. שום נתון אינו נשמר באפליקציה ושום מידע לא נשלח לאינטרנט. כל קובצי הבחינות והתשובות נשארים ונקראים <strong>אך ורק על המחשב האישי שלכם</strong> כחלק מבסיס האבטחה של המערכת.</p>
        </div>
      </div>
      
      ${errMsg ? `<div class="err">${esc(errMsg)}</div>` : ''}
    </div>`;
  const pick = document.getElementById('pick'); if (pick) pick.onclick = () => pickFolder();
  const resume = document.getElementById('resume'); if (resume) resume.onclick = () => resumeFolder();
}

function showNav() {
  renderTopbar();
  let commonMeta = '';
  if (students.length > 0) {
    const m = students[0].meta;
    if (m?.code || m?.term) {
      commonMeta = ` · ${esc(m.code ? 'שאלון ' + m.code : '')} ${esc(m.term || '')}`.trim();
    }
  }

  const cards = students.map((s, i) => {
    return `
    <a class="card" href="#${encodeURIComponent(s.id)}">
      <div class="sid">${esc(s.id)}</div>
      <div class="go">צפייה ←</div>
    </a>`;
  }).join('');
  
  $app.innerHTML = `
    <div class="page-head">
      <div class="kicker">תיקיית הבחינות</div>
      <h1 class="page-h">בחינות תלמידים</h1>
      <p class="lede">${students.length} תלמידים${commonMeta} · לחצו על תלמיד לצפייה.</p>
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
    
    // Bind grading inputs
    $app.querySelectorAll('.grade-input').forEach(inp => {
      inp.oninput = (e) => {
        const qnum = e.target.dataset.qnum;
        saveKv(`grade_${model.examId}_${student.id}_${qnum}`, e.target.value);
        model.questions.find(q=>q.num == qnum).grade = e.target.value;
      };
    });
    $app.querySelectorAll('.comment-input').forEach(inp => {
      inp.oninput = (e) => {
        const qnum = e.target.dataset.qnum;
        saveKv(`comment_${model.examId}_${student.id}_${qnum}`, e.target.value);
        model.questions.find(q=>q.num == qnum).comment = e.target.value;
      };
    });
    $app.querySelectorAll('.override-points').forEach(inp => {
      inp.oninput = (e) => {
        const qnum = e.target.dataset.qnum;
        const val = e.target.value !== '' ? parseInt(e.target.value, 10) : null;
        saveKv(`override_${model.examId}_${qnum}`, val);
        model.questions.find(q=>q.num == qnum).overridePoints = val;
        // update max on grade input
        const gInp = document.querySelector(`.grade-input[data-qnum="${qnum}"]`);
        if (gInp) gInp.setAttribute('max', val !== null ? val : '');
      };
    });

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
