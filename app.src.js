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

// ---------- Portable Per-Student Grading Storage ----------
let allGrades = {}; // { studentId: { key: value } }
let saveTimeouts = {};
let currentStudentId = null; // student currently on screen (for save-state feedback)

// Reflects the save lifecycle in the student header. No-ops unless that student
// is the one on screen, so a debounced save firing after navigation stays silent.
function setSaveState(studentId, state) {
  if (studentId !== currentStudentId) return;
  const el = document.getElementById('save-state');
  if (!el) return;
  if (state === 'saving') {
    el.className = 'save-state saving';
    el.innerHTML = `<span class="dot"></span>שומר…`;
  } else if (state === 'saved') {
    const t = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    el.className = 'save-state saved';
    el.innerHTML = `<span class="dot"></span>נשמר ✓ ${esc(t)}`;
  } else if (state === 'error') {
    el.className = 'save-state error';
    el.innerHTML = `<span class="dot"></span>השמירה נכשלה <button type="button" class="retry">נסה שוב</button>`;
    el.querySelector('.retry').onclick = async () => {
      const student = students.find(s => s.id === studentId);
      if (student && !(await ensurePermission(student.dir))) return;
      saveStudentGrades(studentId);
    };
  } else {
    el.className = 'save-state';
    el.innerHTML = '';
  }
}

async function saveStudentGrades(studentId) {
  const student = students.find(s => s.id === studentId);
  if (!student) return false;
  setSaveState(studentId, 'saving');
  try {
    const fileHandle = await student.dir.getFileHandle('grades.json', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(allGrades[studentId] || {}, null, 2));
    await writable.close();
    setSaveState(studentId, 'saved');
    return true;
  } catch (e) {
    console.error(`Failed to save grades for ${studentId}`, e);
    setSaveState(studentId, 'error');
    return false;
  }
}

function setStudentGradeData(studentId, key, val) {
  if (!allGrades[studentId]) allGrades[studentId] = {};
  if (val === null || val === '') delete allGrades[studentId][key];
  else allGrades[studentId][key] = val;

  setSaveState(studentId, 'saving'); // immediate feedback while the write is debounced
  if (saveTimeouts[studentId]) clearTimeout(saveTimeouts[studentId]);
  saveTimeouts[studentId] = setTimeout(() => saveStudentGrades(studentId), 1000);
}

function getStudentGradeData(studentId, key) {
  return allGrades[studentId]?.[key];
}

// The overall grade is the sum of the per-section grades; recompute and persist it.
function recomputeOverall(studentId) {
  let sum = 0, any = false;
  $app.querySelectorAll('.grade-input').forEach(inp => {
    if (inp.dataset.itemkey === 'overall') return;
    const v = inp.value.trim();
    if (v !== '') { sum += parseInt(v, 10) || 0; any = true; }
  });
  const overall = $app.querySelector('.grade-input[data-itemkey="overall"]');
  const val = any ? String(sum) : '';
  if (overall) overall.value = val;
  setStudentGradeData(studentId, 'grade_overall', val);
}

// Read-only per-question total: sum of its sub-section grades, shown in the
// question header. Purely derived (never persisted) — recomputed live on edit.
function recomputeQuestionTotals() {
  $app.querySelectorAll('section.q').forEach(sec => {
    const el = sec.querySelector('.q-total');
    if (!el) return;
    let sum = 0, any = false;
    sec.querySelectorAll('.grade-input').forEach(inp => {
      const v = inp.value.trim();
      if (v !== '') { sum += parseInt(v, 10) || 0; any = true; }
    });
    el.hidden = !any;
    if (any) el.querySelector('.q-total-val').textContent = String(sum);
  });
}

// Flush any debounced saves immediately (e.g. before re-scanning the folder),
// so a fast navigation never drops an unwritten edit.
async function flushPendingSaves() {
  for (const id of Object.keys(saveTimeouts)) {
    if (saveTimeouts[id]) { clearTimeout(saveTimeouts[id]); delete saveTimeouts[id]; await saveStudentGrades(id); }
  }
}

// Grading completion for the student list: 'done' once a final exam grade is set,
// 'progress' if any per-item mark exists, otherwise 'none'.
function gradingStatus(studentId) {
  const g = allGrades[studentId] || {};
  const overall = g.grade_overall;
  if (overall != null && String(overall).trim() !== '') return { state: 'done', grade: String(overall).trim() };
  const hasMarks = Object.keys(g).some(k => (k.startsWith('grade_') || k.startsWith('comment_')) && String(g[k]).trim() !== '');
  return { state: hasMarks ? 'progress' : 'none' };
}

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
  const strip = s => s.replace(/^[:\s]+/, '');
  return { type: strip(after('סוג הבחינה', /\S[^:]*?(?=\s*מועד|\s*סמל|$)/)), code: after('סמל השאלון', /\d{4,}/), term: strip(after('מועד הבחינה', /[^:]+?\d{4}/)) };
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
      items.push({ ...parseItemId(div.id), type: 'inplace', answerHtml: DOMPurify.sanitize(div.innerHTML.trim()), answerText: a });
    });
    page.querySelectorAll('select').forEach(sel => {
      const s = txt(sel.querySelector('option[selected]')); if (!s) return;
      items.push({ type: 'cloze', key: 'cloze_' + pageid, selected: s });
    });
    if (!items.length) return;

    const clone = page.cloneNode(true);
    clone.querySelectorAll('[id^="ans_"], .textarea, .BtnDiv, [type="RecordAnswer"], iframe, script, style, .asset_resize_link, .modal, img').forEach(e => e.remove());
    const promptHtml = DOMPurify.sanitize(clone.innerHTML
      .replace(/\s(width|height)\s*:\s*\d+px/gi, '')
      .replace(/(\s*<br\s*\/?>\s*){3,}/gi, '<br><br>')
      .replace(/(&nbsp;|\s)+/g, ' ').trim());

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
      it.grade = getStudentGradeData(student.id, `grade_${it.key}`) || '';
      it.comment = getStudentGradeData(student.id, `comment_${it.key}`) || '';
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
  
  for (const student of students) {
    const sid = student.id;
    const stGrades = allGrades[sid] || {};
    const itemKeys = [...new Set(Object.keys(stGrades)
      .filter(k => k.startsWith('grade_') || k.startsWith('comment_'))
      .map(k => k.replace(/^(grade|comment)_/, ''))
    )].sort();
    
    for (const ik of itemKeys) {
      const g = stGrades[`grade_${ik}`] || '';
      const c = stGrades[`comment_${ik}`] || '';
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

function buildPdfItemContent(it, q) {
  if (it.type === 'inplace') {
    return `<div class="ans-body">${it.answerHtml || esc(it.answerText)}</div>`;
  }
  if (it.type === 'cloze') {
    return `<div class="ans-body"><span class="chip">${esc(it.selected)}</span></div>`;
  }
  if (it.type === 'asset') {
    const snaps = it.data.snapshots || [];
    if (!snaps.length) return `<div class="ans-body"><span class="chip">תשובת יישומון צילום</span><div class="missing">לא צולמו תמונות ביישומון.</div></div>`;
    const html = snaps.map((s, i) => {
      const textHtml = esc(s.text || '').replace(/\n/g, '<br>');
      let imgUrl = null;
      if (q && q.stimulus && q.stimulus.galleries) {
        const filename = s.src ? s.src.split('/').pop() : null;
        if (filename) {
          const sortedGals = [...q.stimulus.galleries].sort((a, b) => {
            const aInSrc = s.src && s.src.includes(a.name) ? 1 : 0;
            const bInSrc = s.src && s.src.includes(b.name) ? 1 : 0;
            if (aInSrc !== bInSrc) return bInSrc - aInSrc;
            if (it.part && q.num != null) {
              const re = new RegExp(`^PhotoGallery_Q0*${q.num}${it.part}$`, 'i');
              const aPart = re.test(a.name) ? 1 : 0;
              const bPart = re.test(b.name) ? 1 : 0;
              if (aPart !== bPart) return bPart - aPart;
            }
            return 0;
          });
          for (const gal of sortedGals) {
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
          if (s.width && s.height) { aspect = (zr.width * s.width) / (zr.height * s.height); }
          imgHtml = `<div class="snap-crop" style="background-image:url(${imgUrl}); background-size:${bgSize}; background-position:${bgPosX} ${bgPosY}; aspect-ratio:${aspect};"></div>`;
        } else {
          imgHtml = `<img src="${imgUrl}" class="snap-crop" alt=""/>`;
        }
      }
      return `<div class="snap-item">${imgHtml}<div class="snap-text"><div class="snap-label">תמונה ${i + 1}</div><p>${textHtml}</p></div></div>`;
    }).join('');
    return `<div class="ans-body"><div style="margin-bottom:8px"><span class="chip">תשובת יישומון צילום</span></div>${html}</div>`;
  }
  if (it.type === 'table') {
    return `<div class="table-wrap"><table>
      ${it.headers?.length ? `<thead><tr>${it.headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>` : ''}
      <tbody>${it.rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
  }
  return '';
}

function buildPdfQuestion(q) {
  const title = (q.title || (q.num != null ? 'שאלה ' + q.num : 'שאלה')).replace(/^[\s–—-]+/, '');
  const itemsHtml = q.items.map(it => {
    const tag = it.part ? `${PART[it.part] || it.part}${it.slot ? `(${it.slot})` : ''}` : (it.slot ?? '');
    const content = buildPdfItemContent(it, q);
    const gradeHtml = it.grade !== '' ? `<div class="pdf-grade">${esc(String(it.grade))}</div>` : '';
    const commentHtml = it.comment ? `<div class="pdf-comment">${esc(it.comment)}</div>` : '';
    const hasGrading = gradeHtml || commentHtml;
    return `<div class="pdf-item">
      ${hasGrading ? `<div class="pdf-item-grades">${gradeHtml}${commentHtml}</div>` : ''}
      <div class="pdf-item-main">${tag !== '' ? `<div class="ans-tag">${esc(String(tag))}</div>` : ''}${content}</div>
    </div>`;
  }).join('');
  return `<section class="pdf-question">
    <div class="q-head">
      <h3><span class="qbadge">${esc(String(q.num ?? '✦'))}</span><span>${esc(title)}</span></h3>
      ${renderStimulus(q.stimulus)}
      ${q.promptHtml ? `<details class="prompt-wrap" open><summary>השאלה</summary><div class="prompt-body">${q.promptHtml}</div></details>` : ''}
      <div class="answers-head">תשובות התלמיד</div>
    </div>
    ${itemsHtml}
  </section>`;
}

function buildPrintDocument({ model, overall, overallComment, questionsHtml }) {
  const m = model.meta || {};
  const fontUrl = 'https://fonts.googleapis.com/css2?family=Frank+Ruhl+Libre:wght@500;700;900&family=Assistant:wght@400;600;700&display=swap';
  const overallHtml = (overall || overallComment) ? `
    <div class="pdf-overall">
      <div class="overall-circle">${esc(overall) || '—'}</div>
      ${overallComment ? `<div class="overall-comment">${esc(overallComment)}</div>` : ''}
    </div>` : '';
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<title>תלמיד ${esc(model.id)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${fontUrl}" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;}
html{font-size:14px;}
body{margin:0;padding:20mm 18mm;font-family:"Assistant","Segoe UI",system-ui,sans-serif;font-size:13px;line-height:1.7;color:#1a1810;direction:rtl;}
h2,h3{font-family:"Frank Ruhl Libre",Georgia,serif;margin:0;}
.pdf-header{background:#0d423d;color:#f6f1e6;border-radius:12px;padding:20px 24px;margin-bottom:20px;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.pdf-header .kicker{font-size:11px;font-weight:800;letter-spacing:.12em;opacity:.7;text-transform:uppercase;margin-bottom:6px;}
.pdf-header h2{font-size:22px;font-weight:900;margin-bottom:8px;}
.pdf-header .meta{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;color:rgba(246,241,230,.8);}
.pdf-header .meta b{color:#fff;}
.pdf-header .answered{margin-top:10px;font-size:11px;color:rgba(246,241,230,.65);border-top:1px solid rgba(255,255,255,.15);padding-top:8px;}
.pdf-overall{display:flex;gap:16px;align-items:flex-start;margin-bottom:18px;padding-bottom:14px;border-bottom:1px dashed #dbd0bc;}
.overall-circle{width:58px;height:58px;border-radius:50%;border:2px solid #195cbb;display:grid;place-items:center;font-family:"Frank Ruhl Libre",serif;font-weight:700;font-size:22px;color:#195cbb;flex-shrink:0;}
.overall-comment{font-size:13px;color:#195cbb;font-weight:600;padding-top:8px;line-height:1.5;}
.pdf-question{margin-bottom:24px;}
.pdf-question h3{display:flex;align-items:center;gap:10px;font-size:17px;color:#0d423d;margin-bottom:10px;}
.qbadge{flex:0 0 auto;width:30px;height:30px;display:grid;place-items:center;border-radius:50%;background:#f4eee2;border:1.5px solid #a9772f;color:#a9772f;font-size:13px;font-weight:700;}
.answers-head{font-size:10px;font-weight:800;color:#a9772f;letter-spacing:.2em;margin:8px 0 6px;border-bottom:1px solid #e7ddcc;padding-bottom:4px;text-transform:uppercase;}
.prompt-wrap{background:#f4eee2;border:1px solid #e7ddcc;border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:12.5px;}
.prompt-wrap summary{font-size:11px;font-weight:800;color:#155e57;letter-spacing:.08em;cursor:default;}
.prompt-body{margin-top:6px;overflow-wrap:break-word;}
.prompt-body table{width:100%;max-width:100%;border-collapse:collapse;font-size:12px;border:1px solid #ddd3c0;table-layout:fixed;}
.prompt-body td,.prompt-body th{border:1px solid #ddd3c0;padding:5px 8px;vertical-align:middle;background:transparent;width:auto;overflow-wrap:break-word;word-break:break-word;}
.prompt-body img{max-width:100%;height:auto;}
.prompt-body *:empty:not(img):not(input):not(br):not(td):not(th):not(hr){display:none;}
.prompt-body select{max-width:100%;width:100%;font-family:inherit;font-size:12px;border:1px solid #cfe3df;border-radius:6px;padding:2px 6px;background:#fff;color:#1a1810;appearance:auto;}
.pdf-item{display:flex;gap:12px;padding:8px 0;border-bottom:1px solid #e7ddcc;}
.pdf-item:last-child{border-bottom:none;}
.pdf-item-main{flex:1;display:flex;gap:10px;min-width:0;}
.pdf-item-grades{flex:0 0 80px;display:flex;flex-direction:column;gap:4px;padding-inline-end:10px;border-inline-end:1px dashed rgba(25,92,187,.3);}
.ans-tag{flex:0 0 auto;min-width:26px;height:26px;padding:0 5px;display:grid;place-items:center;background:#e4efec;color:#0d423d;border:1px solid #cfe3df;border-radius:6px;font-family:"Frank Ruhl Libre",serif;font-weight:700;font-size:13px;align-self:flex-start;margin-top:2px;}
.ans-tag:empty{display:none;}
.ans-body{flex:1;font-size:13px;min-width:0;}
.ans-body p{margin:0 0 4px;}
.chip{background:#f3e9d6;border:1px solid #e7d4b0;border-radius:999px;padding:2px 10px;display:inline-block;font-weight:600;color:#7c5310;font-size:12px;}
.pdf-grade{font-family:"Frank Ruhl Libre",serif;font-weight:700;font-size:15px;color:#195cbb;text-align:center;line-height:1.2;}
.pdf-comment{font-size:11px;color:#195cbb;font-weight:500;line-height:1.4;}
.missing{font-size:12px;color:#999;font-style:italic;}
.stimulus{margin-bottom:10px;}
.thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px;}
.thumb{display:block;padding:4px 4px 6px;background:#f4eee2;border:1px solid #dbd0bc;border-radius:4px;text-decoration:none;}
.thumb img{max-height:160px;max-width:220px;width:auto;height:auto;display:block;}
.snap-item{display:flex;gap:12px;margin-top:8px;align-items:flex-start;}
.snap-crop{width:120px;height:85px;border-radius:6px;border:1px solid #dbd0bc;background-repeat:no-repeat;flex-shrink:0;background-color:#f4eee2;}
.snap-crop img{width:100%;height:100%;object-fit:cover;border-radius:6px;}
.snap-label{font-size:11px;font-weight:700;color:#a9772f;margin-bottom:2px;}
.snap-text{flex:1;font-size:12.5px;line-height:1.5;}
.snap-text p{margin:0;}
.table-wrap{max-width:100%;}
table{border-collapse:collapse;font-size:12px;width:auto;max-width:100%;}
th,td{border:1px solid #dbd0bc;padding:5px 10px;text-align:start;vertical-align:top;min-width:60px;}
th{background:#f4eee2;font-weight:700;}
td:empty{background:#f9f7f3;color:#bbb;}
@media print{
  body{padding:15mm 14mm;}
  .pdf-header{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  .pdf-item{break-inside:avoid;}
}
</style>
</head>
<body>
<header class="pdf-header">
  <div class="kicker">תיק בחינה</div>
  <h2>תלמיד · ${esc(model.id)}</h2>
  <div class="meta">
    ${m.type ? `<span><b>סוג:</b> ${esc(m.type)}</span>` : ''}
    ${m.term ? `<span><b>מועד:</b> ${esc(m.term)}</span>` : ''}
    ${m.code ? `<span><b>סמל שאלון:</b> ${esc(m.code)}</span>` : ''}
  </div>
  <div class="answered">שאלות שנענו: ${model.answered.join(', ') || '—'}${model.answered.length > 0 ? ` (סה״כ ${model.answered.length})` : ''}</div>
</header>
${overallHtml}
${questionsHtml}
<script>if(document.readyState==='complete'){window.focus();window.print();}<\/script>
</body>
</html>`;
}

function exportStudentPdf(model) {
  const grades = allGrades[model.id] || {};
  const overall = grades.grade_overall || '';
  const overallComment = grades.comment_overall || '';
  const questionsHtml = model.questions.map(q => buildPdfQuestion(q)).join('');
  const docHtml = buildPrintDocument({ model, overall, overallComment, questionsHtml });

  const newWin = window.open('', '_blank');
  if (!newWin) {
    alert('הדפדפן חסם את פתיחת החלון. אנא אפשר חלונות קופצים לאתר זה ונסה שוב.');
    return;
  }
  newWin.document.open();
  newWin.document.write(docHtml);
  newWin.document.close();
  newWin.onload = () => { newWin.focus(); newWin.print(); };
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
  return `
    <div class="teacher-pen" title="הערכת מורה">
      <div class="pen-grade">
        <input type="text" class="grade-input" data-itemkey="${esc(it.key)}" inputmode="numeric" value="${esc(it.grade)}" placeholder="ציון" />
      </div>
      <div class="pen-comment">
        <textarea class="comment-input" data-itemkey="${esc(it.key)}" placeholder="הערה...">${esc(it.comment)}</textarea>
      </div>
    </div>`;
}

function renderItem(it, q) {
  const tag = it.part ? `${PART[it.part] || it.part}${it.slot ? `(${it.slot})` : ''}` : (it.slot ?? '');
  const sPart = `<div class="ans-tag">${esc(tag)}</div>`;
  
  let content = '';
  if (it.type === 'inplace') {
    content = `<div class="ans-body">${it.answerHtml || esc(it.answerText)}</div>`;
  } else if (it.type === 'cloze') {
    content = `<div class="ans-body"><span class="chip">${esc(it.selected)}</span></div>`;
  } else if (it.type === 'asset') {
    let html = '';
    const snaps = it.data.snapshots || [];
    if (snaps.length > 0) {
      html = snaps.map((s, i) => {
        const textHtml = esc(s.text || '').replace(/\n/g, '<br>');
        let imgUrl = null;
        if (q && q.stimulus && q.stimulus.galleries) {
          const filename = s.src ? s.src.split('/').pop() : null;
          if (filename) {
            const sortedGals = [...q.stimulus.galleries].sort((a, b) => {
              const aInSrc = s.src && s.src.includes(a.name) ? 1 : 0;
              const bInSrc = s.src && s.src.includes(b.name) ? 1 : 0;
              if (aInSrc !== bInSrc) return bInSrc - aInSrc;
              if (it.part && q.num != null) {
                const re = new RegExp(`^PhotoGallery_Q0*${q.num}${it.part}$`, 'i');
                const aPart = re.test(a.name) ? 1 : 0;
                const bPart = re.test(b.name) ? 1 : 0;
                if (aPart !== bPart) return bPart - aPart;
              }
              return 0;
            });
            for (const gal of sortedGals) {
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
            if (s.width && s.height) { aspect = (zr.width * s.width) / (zr.height * s.height); }
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
    content = `<div class="ans-body"><div style="margin-bottom:12px"><span class="chip">תשובת יישומון צילום</span></div>${html}</div>`;
  } else if (it.type === 'table') {
    content = `<div class="table-wrap"><table>
      ${it.headers?.length ? `<thead><tr>${it.headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>` : ''}
      <tbody>
        ${it.rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}
      </tbody>
    </table></div>`;
  } else {
    content = `<span style="color:var(--rose)">סוג שאלה לא נתמך: ${esc(it.type)}</span>`;
  }
  
  return `<div class="ans ${it.type}">${sPart}${content}</div>`;
}
function renderStudentPage(model) {
  const m = model.meta || {};
  const examId = model.examId;
  const qs = model.questions.map(q => {
    const title = (q.title || (q.num != null ? 'שאלה ' + q.num : 'שאלה')).replace(/^[\s–—-]+/, '');
    const rows = q.items.map((it, i) => `
      <div class="ans-cell${i ? ' sep' : ''}" style="grid-row:${i + 2}">${renderItem(it, q)}</div>
      <div class="q-note" style="grid-row:${i + 2}">${renderSubGrading(it)}</div>`).join('');
    return `
    <section class="q" data-qnum="${q.num}">
      <div class="q-total" hidden title="סכום ציוני השאלה" style="grid-row:${q.items.length + 2}"><span class="q-total-val"></span></div>
      <div class="q-paper" aria-hidden="true" style="grid-row: 1 / ${q.items.length + 2}"></div>
      <div class="q-head">
        <div class="q-header">
          <h3><span class="qbadge">${esc(q.num ?? '✦')}</span><span>${esc(title)}</span></h3>
        </div>
        ${renderStimulus(q.stimulus)}
        ${q.promptHtml ? `<details class="prompt" open><summary>השאלה</summary><div class="prompt-body">${q.promptHtml}</div></details>` : ''}
        <div class="answers-head">תשובות התלמיד</div>
      </div>
      ${rows}
    </section>`;
  }).join('');
  return `
    <a class="backlink" href="#"><span>→</span><span>חזרה לרשימת התלמידים</span></a>
    <header class="exam">
      <div class="save-state" id="save-state" aria-live="polite"></div>
      <div class="label kicker">תיק בחינה</div>
      <h2>תלמיד · ${esc(model.id)}</h2>
      <div class="meta">
        ${m.type ? `<span><b>סוג:</b> ${esc(m.type)}</span>` : ''}
        ${m.term ? `<span><b>מועד:</b> ${esc(m.term)}</span>` : ''}
        ${m.code ? `<span><b>סמל שאלון:</b> ${esc(m.code)}</span>` : ''}
      </div>
      <div class="answered">שאלות שנענו: ${model.answered.join(', ') || '—'} ${model.answered.length > 0 ? `<span style="opacity:0.75; font-size:0.9em; margin-inline-start:4px;">(סה״כ ${model.answered.length})</span>` : ''}</div>
      <div class="exam-actions">
        <button type="button" id="export-pdf-btn" class="export-pdf-btn">⬇ שמירה כ-PDF</button>
      </div>
    </header>
    <section class="exam-grade">
      <label class="eg-grade">
        <span>ציון סופי (סכום)</span>
        <input type="text" class="grade-input" data-itemkey="overall" inputmode="numeric" readonly
               value="${esc(getStudentGradeData(model.id, 'grade_overall') || '')}" placeholder="—" />
      </label>
      <label class="eg-comment">
        <span>הערה כללית לתלמיד</span>
        <textarea class="comment-input" data-itemkey="overall"
                  placeholder="הערה כללית על הבחינה…">${esc(getStudentGradeData(model.id, 'comment_overall') || '')}</textarea>
      </label>
    </section>
    ${qs || '<p>לא נמצאו תשובות.</p>'}`;
}

// ---------- views ----------

function showWelcome(lastName, errMsg) {
  $topbar.innerHTML = '';
  $app.parentElement.classList.remove('wrap--content');
  
  const currentName = rootHandle ? rootHandle.name : lastName;
  let buttonsHtml = '';
  if (rootHandle) {
    buttonsHtml = `
      <div class="split-btn">
        <button class="primary big" id="resume-current">המשך בתיקייה הנוכחית · ${esc(currentName)}</button>
        <button class="primary big split-toggle" id="split-toggle" aria-haspopup="true" aria-expanded="false" aria-label="אפשרויות נוספות">▾</button>
        <div class="split-drop" id="split-drop" hidden>
          <button id="pick">פתיחת תיקייה חדשה</button>
        </div>
      </div>`;
  } else if (lastName) {
    buttonsHtml = `
      <div class="split-btn">
        <button class="primary big" id="resume">פתיחת התיקייה האחרונה · ${esc(lastName)}</button>
        <button class="primary big split-toggle" id="split-toggle" aria-haspopup="true" aria-expanded="false" aria-label="אפשרויות נוספות">▾</button>
        <div class="split-drop" id="split-drop" hidden>
          <button id="pick">בחירת תיקייה אחרת</button>
        </div>
      </div>`;
  } else {
    buttonsHtml = `<button class="primary big" id="pick">בחירת תיקייה להתחלה…</button>`;
  }

  const existing = $app.querySelector('.welcome');
  if (existing) {
    const ctaGroup = existing.querySelector('.cta-group');
    if (ctaGroup) ctaGroup.innerHTML = buttonsHtml;
    
    let errEl = existing.querySelector('.err');
    if (errMsg) {
      if (errEl) {
        errEl.textContent = errMsg;
      } else {
        existing.querySelector('.welcome-main').insertAdjacentHTML('beforeend', `<div class="err">${esc(errMsg)}</div>`);
      }
    } else if (errEl) {
      errEl.remove();
    }
  } else {
    $app.innerHTML = `
      <div class="welcome">
        <div class="welcome-main">
          <h1 dir="ltr">Open Teacher <em>Assessment</em></h1>
          <div class="hero-subtitle">מערכת פשוטה ומודרנית לצפייה ובדיקת בחינות הדמייה מכל מקום.</div>

          <div class="cta-group">
            ${buttonsHtml}
          </div>
          ${errMsg ? `<div class="err">${esc(errMsg)}</div>` : ''}
        </div>

        <footer class="welcome-footer">
          <div class="footer-col steps">
            <details>
              <summary>📖 איך מתחילים?</summary>
              <ol>
                <li>גלשו בדפדפן <strong>Chrome</strong> או <strong>Edge</strong> בגרסה עדכנית.</li>
                <li>הכינו מראש את תיקיית הבחינות במחשב – אפשר לקבל אותה מאיש המחשבים בבית הספר או להוריד מ-iTest.</li>
                <li>ודאו שמדובר בתיקייה רגילה ולא בקובץ Zip, ושבתוכה יש תיקייה נפרדת לכל תלמיד עם שם שהוא מספר תעודת הזהות שלו.</li>
                <li>בחרו תיקייה שמכילה את <strong>כלל התלמידים בכיתה</strong> – המערכת תציג מעקב אחר תהליך הבדיקה, ממוצע כולל ועוד.</li>
                <li>לחצו על הכפתור הכחול למעלה ובחרו את התיקייה.</li>
                <li><a href="https://youtube.com/watch?v=mhr91sxjvnQ&si=h7iWePzWc2UWaXA4" target="_blank" rel="noopener">סרטון הדרכה לשימוש באפליקציה ↗</a></li>
              </ol>
            </details>
          </div>
          <div class="footer-col security">
            <details>
              <summary>🛡️ קוד פתוח ואבטחה</summary>
              <p>פרויקט <strong>קוד פתוח</strong>. אין שרת, אין ענן – כל הנתונים נקראים ישירות מהמחשב שלכם <strong>ולא עוזבים אותו לרגע</strong>.</p>
              <p class="rakefet-credit">נבנה בהשראתה של רקפת ממקיף גוונים שהיא ההשראה שלי<img src="rakefet.png" alt="רקפת" width="24" height="24" style="display:inline-block;vertical-align:middle;margin-right:4px;"></p>
              <p class="repo-link"><a href="https://github.com/shlomsh/open-teacher-assesment" target="_blank" rel="noopener">צפייה בקוד המקור ב-GitHub ↗</a></p>
            </details>
          </div>
        </footer>
      </div>`;
  }

  const pickBtn = document.getElementById('pick'); if (pickBtn) pickBtn.onclick = () => pickFolder();
  const resumeBtn = document.getElementById('resume'); if (resumeBtn) resumeBtn.onclick = () => resumeFolder();
  const resumeCurBtn = document.getElementById('resume-current'); if (resumeCurBtn) resumeCurBtn.onclick = () => { location.hash = ''; };

  const splitToggle = document.getElementById('split-toggle');
  const splitDrop = document.getElementById('split-drop');
  if (splitToggle && splitDrop) {
    splitToggle.onclick = (e) => {
      e.stopPropagation();
      const opening = splitDrop.hidden;
      splitDrop.hidden = !opening;
      splitToggle.setAttribute('aria-expanded', String(opening));
      if (opening) {
        // only listen for outside clicks while the dropdown is open; auto-removes after one fire
        setTimeout(() => {
          document.addEventListener('click', function close(ev) {
            if (!splitDrop.contains(ev.target)) {
              splitDrop.hidden = true;
              document.removeEventListener('click', close);
            }
          });
        }, 0);
      }
    };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') splitDrop.hidden = true; });
  }
}

function showNav() {
  currentStudentId = null;
  $topbar.innerHTML = '';
  $app.parentElement.classList.add('wrap--content');
  const statuses = students.map(s => gradingStatus(s.id));
  const doneCount = statuses.filter(st => st.state === 'done').length;

  // Class average — over graded students only (those with an overall grade).
  const gradedScores = statuses
    .filter(st => st.state === 'done')
    .map(st => parseFloat(st.grade))
    .filter(g => !isNaN(g));
  let avgDisplay = '—';
  if (gradedScores.length) {
    const avg = gradedScores.reduce((a, b) => a + b, 0) / gradedScores.length;
    avgDisplay = Number.isInteger(avg) ? String(avg) : avg.toFixed(1);
  }

  let summaryHtml = '';
  if (students.length > 0) {
    const m = students[0].meta;
    if (m?.code || m?.term || m?.type) {
      summaryHtml = `
      <div class="exam-summary">
        <div class="summary-item"><span class="val">${students.length}</span><span class="lbl">תלמידים</span></div>
        <div class="summary-sep"></div>
        <div class="summary-item"><span class="val">${doneCount}/${students.length}</span><span class="lbl">הוערכו</span></div>
        <div class="summary-sep"></div>
        <div class="summary-item"><span class="val">${esc(avgDisplay)}</span><span class="lbl">ממוצע ציונים</span></div>
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

  // Row model for the list. `n` is the original 1-based position (the "#" sort).
  // `remark` is the teacher's overall per-test comment (comment_overall).
  const rows = students.map((s, i) => ({
    n: i + 1,
    id: s.id,
    state: statuses[i].state,
    grade: statuses[i].state === 'done' ? (statuses[i].grade || '') : '',
    remark: getStudentGradeData(s.id, 'comment_overall') || '',
  }));

  let sortKey = 'num';     // num | id | status | grade | remark
  let sortDir = 'asc';     // asc | desc
  let filterKey = 'all';   // all | done | progress | none

  // Status sort groups in-progress first (resume work), then untouched, then done.
  const statusOrder = { progress: 0, none: 1, done: 2 };
  const gradeNum = (r) => (r.grade !== '' ? parseInt(r.grade, 10) : -Infinity);
  const defaultDir = { num: 'asc', id: 'asc', status: 'asc', grade: 'desc', remark: 'asc' };

  function baseCmp(x, y) {
    switch (sortKey) {
      case 'id': return Number(x.id) - Number(y.id);
      case 'status': return statusOrder[x.state] - statusOrder[y.state];
      case 'grade': return gradeNum(x) - gradeNum(y);
      case 'remark':
        if (!x.remark && !y.remark) return 0;
        if (!x.remark) return 1;            // rows without a remark sink to the bottom
        if (!y.remark) return -1;
        return x.remark.localeCompare(y.remark, 'he');
      default: return x.n - y.n;
    }
  }
  function sortRows(arr) {
    return arr.slice().sort((x, y) => {
      const r = baseCmp(x, y) || (x.n - y.n);   // stable tiebreak on original order
      return sortDir === 'asc' ? r : -r;
    });
  }

  const COLS = [
    { key: 'num',    label: '#' },
    { key: 'id',     label: 'תעודת זהות' },
    { key: 'status', label: 'סטטוס' },
    { key: 'grade',  label: 'ציון' },
    { key: 'remark', label: 'הערה כללית לתלמיד', cls: 'col-remark' },
  ];
  const headCell = (c) => {
    const active = sortKey === c.key;
    const ind = active ? (sortDir === 'asc' ? '▲' : '▼') : '↕';
    return `<button type="button" class="col-head sortable${c.cls ? ' ' + c.cls : ''}${active ? ' sorted' : ''}"
      data-sort="${c.key}" aria-label="מיון לפי ${esc(c.label)}">${esc(c.label)} <span class="sort-ind">${ind}</span></button>`;
  };

  const statusCell = (r) =>
    r.state === 'done' ? `<span class="row-status done">הוערך</span>`
    : r.state === 'progress' ? `<span class="row-status progress"><span class="dot"></span>בתהליך</span>`
    : `<span class="row-status none">טרם הוערך</span>`;

  function renderList() {
    const listEl = document.getElementById('student-list');
    if (!listEl) return;
    if (!rows.length) {
      listEl.innerHTML = `<div class="list-empty">לא נמצאו תיקיות תלמידים עם <code>standalone_open</code> בתיקייה שנבחרה.</div>`;
      return;
    }
    const visible = sortRows(rows.filter(r => filterKey === 'all' || r.state === filterKey));
    listEl.innerHTML = `
      <div class="list-header list-grid">${COLS.map(headCell).join('')}</div>
      ${visible.length
        ? visible.map(r => `
        <a class="student-row list-grid" href="#${encodeURIComponent(r.id)}">
          <span class="row-num">${esc(String(r.n).padStart(2, '0'))}</span>
          <span class="row-id">${esc(r.id)}</span>
          ${statusCell(r)}
          <span class="row-grade${r.grade === '' ? ' is-empty' : ''}">${r.grade === '' ? '—' : esc(r.grade)}</span>
          ${r.remark
            ? `<span class="row-remark" title="${esc(r.remark)}">${esc(r.remark)}</span>`
            : `<span class="row-remark is-empty">—</span>`}
        </a>`).join('')
        : `<div class="list-empty">אין תלמידים בסטטוס זה.</div>`}`;
  }

  $app.innerHTML = `
    <a class="backlink" href="#welcome" id="home-link"><span>→</span><span>חזרה למסך הראשי</span></a>
    <div class="page-head">
      <h1 class="page-h">בחינות תלמידים</h1>
      ${summaryHtml}
    </div>
    ${rows.length ? `
    <div class="toolbar">
      <div class="filter-wrap">
        <label class="toolbar-label" for="status-filter">סינון לפי סטטוס</label>
        <select id="status-filter" class="filter-select">
          <option value="all">הכל</option>
          <option value="done">הוערכו</option>
          <option value="progress">בתהליך</option>
          <option value="none">טרם הוערכו</option>
        </select>
      </div>
    </div>` : ''}
    <div class="student-list" id="student-list"></div>`;

  renderList();

  if (rows.length) {
    const listEl = document.getElementById('student-list');
    // Header sorting (delegated, so it survives renderList rebuilding the header).
    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.col-head.sortable');
      if (!btn || !listEl.contains(btn)) return;
      const key = btn.dataset.sort;
      if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortKey = key; sortDir = defaultDir[key]; }
      renderList();
    });
    const sel = document.getElementById('status-filter');
    if (sel) sel.onchange = () => { filterKey = sel.value; renderList(); };
  }
}

async function showStudent(id) {
  const student = students.find(s => s.id === id);
  if (!student) { location.hash = ''; return; }
  currentStudentId = id;
  $topbar.innerHTML = ''; // Hide topbar when viewing a student
  $app.parentElement.classList.add('wrap--content');
  $app.innerHTML = `<div class="spinner">טוען…</div>`;
  try {
    const model = await buildModel(student);
    $app.innerHTML = renderStudentPage(model);
    document.querySelector('.backlink').onclick = (e) => { e.preventDefault(); location.hash = ''; };
    const pdfBtn = document.getElementById('export-pdf-btn');
    if (pdfBtn) pdfBtn.onclick = () => exportStudentPdf(model);
    
    // Bind grading inputs (integer-only; overall is the computed sum of sections)
    $app.querySelectorAll('.grade-input').forEach(inp => {
      if (inp.dataset.itemkey === 'overall') return; // read-only, computed
      inp.oninput = (e) => {
        const itemkey = e.target.dataset.itemkey;
        const clean = e.target.value.replace(/[^\d]/g, '');
        if (clean !== e.target.value) {
          const pos = e.target.selectionStart - (e.target.value.length - clean.length);
          e.target.value = clean;
          try { e.target.setSelectionRange(pos, pos); } catch {}
        }
        setStudentGradeData(student.id, `grade_${itemkey}`, e.target.value);
        recomputeOverall(student.id);
        recomputeQuestionTotals();
      };
    });
    recomputeOverall(student.id);
    recomputeQuestionTotals();
    $app.querySelectorAll('.comment-input').forEach(inp => {
      inp.oninput = (e) => {
        const itemkey = e.target.dataset.itemkey;
        setStudentGradeData(student.id, `comment_${itemkey}`, e.target.value);
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
  await flushPendingSaves();
  $app.parentElement.classList.add('wrap--content');
  $app.innerHTML = `<div class="spinner">סורק תיקיות…</div>`;
  modelCache.clear();
  students = [];
  allGrades = {};
  try {
    for await (const entry of rootHandle.values()) {
      if (entry.kind !== 'directory') continue;
      const idx = await getFile(entry, 'standalone_open', 'index.html');
      if (!idx) continue;
      const html = await idx.text();
      students.push({ id: entry.name, dir: entry, html, meta: quickMeta(html) });
      
      // Load student grades
      try {
        const fh = await entry.getFileHandle('grades.json');
        const file = await fh.getFile();
        allGrades[entry.name] = JSON.parse(await file.text()) || {};
      } catch (e) {
        allGrades[entry.name] = {};
      }
    }
  } catch (e) {
    showWelcome(rootHandle?.name, `לא ניתן לקרוא את התיקייה: ${e.message}`);
    return;
  }
  students.sort((a, b) => a.id.localeCompare(b.id, 'he', { numeric: true }));
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
  history.replaceState(null, '', location.pathname);
  route();
}

async function resumeFolder() {
  try {
    const h = await loadHandle();
    if (!h) return pickFolder();
    if (!(await ensurePermission(h))) { showWelcome(h.name, 'ההרשאה לתיקייה נדחתה.'); return; }
    rootHandle = h;
    history.replaceState(null, '', location.pathname);
    route();
  } catch (e) { showWelcome(null, e.message); }
}

async function route() {
  const id = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (id === 'welcome' || (!rootHandle && !id)) {
    const lastName = await loadHandle().then(h => h ? h.name : null).catch(() => null);
    showWelcome(lastName);
    return;
  }
  if (!rootHandle) return;

  if (id) {
    showStudent(id); 
  } else {
    // Rescan when returning to the student list to pick up newly pasted folders
    if (document.querySelector('.page-head')) {
       // already on nav, but doing a refresh?
    }
    await scanAndShow();
    showNav();
  }
}

window.addEventListener('hashchange', route);

(async function init() {
  if (!window.showDirectoryPicker) { showWelcome(null, 'דרוש דפדפן Chrome או Edge (תמיכה בבחירת תיקייה מקומית).'); return; }
  let last = null;
  try { const h = await loadHandle(); if (h) last = h.name; } catch {}
  showWelcome(last);
})();

// ---------- Lightbox ----------
document.addEventListener('click', e => {
  const thumb = e.target.closest('a.thumb');
  const snapCrop = e.target.closest('.snap-crop');
  const lightbox = e.target.closest('#lightbox');
  
  if (thumb) {
    e.preventDefault();
    showLightbox(thumb.href);
  } else if (snapCrop) {
    let imgUrl = null;
    if (snapCrop.tagName === 'IMG') {
      imgUrl = snapCrop.src;
    } else if (snapCrop.style.backgroundImage) {
      const match = snapCrop.style.backgroundImage.match(/url\("?(.+?)"?\)/);
      if (match) imgUrl = match[1];
    }
    if (imgUrl) showLightbox(imgUrl);
  } else if (lightbox) {
    hideLightbox();
  }
});

function showLightbox(url) {
  const $lightbox = document.getElementById('lightbox');
  const $img = document.getElementById('lightbox-img');
  if ($lightbox && $img) {
    $img.src = url;
    $lightbox.classList.add('active');
  }
}

function hideLightbox() {
  const $lightbox = document.getElementById('lightbox');
  const $img = document.getElementById('lightbox-img');
  if ($lightbox) {
    $lightbox.classList.remove('active');
    setTimeout(() => { if ($img) $img.src = ''; }, 250);
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') hideLightbox();
});
