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

// ---------- Portable Grading Storage ----------
let gradesData = {};
let gradesTimeout = null;

async function loadGrades() {
  if (!rootHandle) return;
  try {
    const fileHandle = await rootHandle.getFileHandle('grades.json', { create: false });
    const file = await fileHandle.getFile();
    const text = await file.text();
    gradesData = JSON.parse(text) || {};
  } catch (e) {
    gradesData = {};
  }
}

async function saveGrades() {
  if (!rootHandle) return;
  try {
    const fileHandle = await rootHandle.getFileHandle('grades.json', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(gradesData, null, 2));
    await writable.close();
  } catch (e) {
    console.error('Failed to save grades.json', e);
  }
}

function setGradeData(key, val) {
  if (val === null || val === '') delete gradesData[key];
  else gradesData[key] = val;
  
  if (gradesTimeout) clearTimeout(gradesTimeout);
  gradesTimeout = setTimeout(saveGrades, 1000);
}

function getGradeData(key) {
  return gradesData[key];
}

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
      items.push({ type: 'cloze', key: 'cloze_' + pageid, selected: s });
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
            if (q) q.items.push({ type: 'asset', part, key, data });
          }
        }
      }
    }
  } catch (e) { console.warn('Could not parse assets.js', e); }

  for (const q of questions) {
    q.items.sort((a, b) => {
      const pA = a.part || ''; const pB = b.part || '';
      if (pA !== pB) return pA.localeCompare(pB);
      return (a.slot || 0) - (b.slot || 0);
    });
    for (const it of q.items) {
      it.overridePoints = getGradeData(`override_${rootHandle.name}_${it.key}`) ?? null;
      it.grade = getGradeData(`grade_${rootHandle.name}_${student.id}_${it.key}`) || '';
      it.comment = getGradeData(`comment_${rootHandle.name}_${student.id}_${it.key}`) || '';
    }
  }

  const answered = [...new Set(questions.map(q => q.num).filter(n => n != null))].sort((a, b) => a - b);
  const model = { id: student.id, meta: student.meta, answered, questions, examId: rootHandle.name };
  modelCache.set(student.id, model);
  return model;
}

// ---------- export logic ----------
async function exportCsv() {
  if (!rootHandle) return;
  const examId = rootHandle.name;
  let csv = '\uFEFF"Student ID","Item","Grade","Comment"\n';
  const rows = [];
  const keys = Object.keys(gradesData).filter(k => k.startsWith(`grade_${examId}_`));
  const studentIds = [...new Set(keys.map(k => k.split('_')[2]))].sort();
  
  for (const sid of studentIds) {
    const items = [...new Set(Object.keys(gradesData)
      .filter(k => k.includes(`_${sid}_`) && k.startsWith('grade_'))
      .map(k => k.split('_').slice(3).join('_')))].sort();
    
    for (const ik of items) {
      const g = gradesData[`grade_${examId}_${sid}_${ik}`] || '';
      const c = gradesData[`comment_${examId}_${sid}_${ik}`] || '';
      if (g !== '' || c !== '') {
        const escCsv = s => '"' + String(s).replace(/"/g, '""') + '"';
        rows.push([escCsv(sid), escCsv(ik), escCsv(g), escCsv(c)].join(','));
      }
    }
  }

  if (!rows.length) return alert('אין ציונים לייצא בתיקייה זו.');
  csv += rows.join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  a.download = `grades_${examId}.csv`;
  a.click();
}

// ---------- rendering (ported from build.mjs) ----------
function renderStimulus(s) {
  if (!s) return '';
  let imgs = s.images || [];
  if (imgs.length === 0) imgs = (s.galleries || []).flatMap(g => g.photos || []);
  const tiles = imgs.map(im => `<a class="thumb" href="${im.url}" target="_blank" title="${esc(im.name)}"><img loading="lazy" src="${im.url}" alt=""></a>`).join('');
  const tour = s.virtualTour ? `<div class="missing">סיור וירטואלי (VirtualTour) לא ניתן להצגה.</div>` : '';
  if (!tiles && !tour) return '';
  return `<div class="stimulus">${tiles ? `<div class="thumbs">${tiles}</div>` : ''}${tour}</div>`;
}

function renderSubGrading(it) {
  const maxP = it.overridePoints !== null ? it.overridePoints : 0;
  return `
    <div class="grading-panel">
      <div class="grading-fields">
        <div class="q-points">
          <label>ניקוד מרבי:</label>
          <input type="number" class="override-points" value="${it.overridePoints ?? ''}" data-itemkey="${esc(it.key)}" />
        </div>
        <div class="grading-grade">
          <label>ציון:</label>
          <input type="number" class="grade-input" data-itemkey="${esc(it.key)}" value="${esc(it.grade)}" max="${maxP}" />
        </div>
        <div class="grading-comment">
          <label>הערה:</label>
          <input type="text" class="comment-input" data-itemkey="${esc(it.key)}" value="${esc(it.comment)}" />
        </div>
      </div>
    </div>`;
}

function renderItem(it, q) {
  const tag = it.part ? `${PART[it.part] || it.part}${it.slot ? `(${it.slot})` : ''}` : (it.slot ?? '');
  const sPart = `<div class="ans-tag">${esc(tag)}</div>`;
  if (it.type === 'inplace')
    return `<div class="ans">${sPart}<div class="ans-body">${it.answerHtml || esc(it.answerText)}</div>${renderSubGrading(it)}</div>`;
  if (it.type === 'cloze')
    return `<div class="ans cloze">${sPart}<div class="ans-body"><span class="chip">${esc(it.selected)}</span></div>${renderSubGrading(it)}</div>`;
  if (it.type === 'asset') {
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
    return `
    <section class="q" data-qnum="${q.num}">
      <div class="q-header">
        <h3><span class="qbadge">${esc(q.num ?? '✦')}</span><span>${esc(title)}</span></h3>
      </div>
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

function showWelcome(lastName, errMsg) {
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
  let summaryHtml = '';
  if (students.length > 0) {
    const m = students[0].meta;
    if (m?.code || m?.term || m?.type) {
      summaryHtml = `
      <div class="exam-summary">
        <div class="summary-item"><span class="val">${students.length}</span><span class="lbl">תלמידים</span></div>
        <div class="summary-sep"></div>
        <div class="summary-item">
          <span class="lbl">שאלון</span><span class="val">${esc(m.code || '—')}</span>
        </div>
        <div class="summary-sep"></div>
        <div class="summary-item highlight">
          <span class="val">${esc(m.type || '')} ${esc(m.term || '')}</span>
        </div>
      </div>`;
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
      <h1 class="page-h">בחינות תלמידים</h1>
      ${summaryHtml}
      <div style="margin-top:20px; animation:rise .6s cubic-bezier(.2,.8,.2,1) both; animation-delay:.1s;">
        <button id="export-csv" class="primary" style="padding:10px 24px; border-radius:12px; font-size:15px; box-shadow:0 4px 12px rgba(13,66,61,.15);">📥 ייצוא ציונים לאקסל (CSV)</button>
      </div>
    </div>
    <div class="grid-header" style="font-size:13px; font-weight:700; color:var(--faint); margin:0 0 12px; letter-spacing:.05em;">בחירת תלמיד להערכה</div>
    <div class="grid">${cards || '<div class="empty">לא נמצאו תיקיות תלמידים עם <code>standalone_open</code> בתיקייה שנבחרה.</div>'}</div>`;
    
  document.getElementById('export-csv').onclick = () => exportCsv();
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
        const itemkey = e.target.dataset.itemkey;
        setGradeData(`grade_${model.examId}_${student.id}_${itemkey}`, e.target.value);
      };
    });
    $app.querySelectorAll('.comment-input').forEach(inp => {
      inp.oninput = (e) => {
        const itemkey = e.target.dataset.itemkey;
        setGradeData(`comment_${model.examId}_${student.id}_${itemkey}`, e.target.value);
      };
    });
    $app.querySelectorAll('.override-points').forEach(inp => {
      inp.oninput = (e) => {
        const itemkey = e.target.dataset.itemkey;
        const val = e.target.value !== '' ? parseInt(e.target.value, 10) : null;
        setGradeData(`override_${model.examId}_${itemkey}`, val);
        // update max on grade input
        const gInp = document.querySelector(`.grade-input[data-itemkey="${itemkey}"]`);
        if (gInp) gInp.setAttribute('max', val !== null ? val : 0);
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
  const opts = { mode: 'readwrite' };
  if (await handle.queryPermission(opts) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

async function scanAndShow() {
  $app.innerHTML = `<div class="spinner">סורק תיקיות…</div>`;
  await loadGrades();
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
    rootHandle = await window.showDirectoryPicker({ id: 'exam-data', mode: 'readwrite' });
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
