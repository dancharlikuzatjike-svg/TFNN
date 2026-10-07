// Usage:
//   node tools/worksheet.js export > worksheet.csv      (English + Afrikaans reference, blank columns)
//   node tools/worksheet.js import worksheet.csv        (writes lang/<code>.json for each filled column)
const fs = require('fs');
const path = require('path');
const LANGS = { oshiwambo: 'ng', otjiherero: 'hz', khoekhoegowab: 'naq', german: 'de' };
const NAMES = { ng: 'Oshiwambo', hz: 'Otjiherero', naq: 'Khoekhoegowab', de: 'Deutsch' };
const langDir = path.join(__dirname, '..', 'lang');
const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
function parse(text) {
  const rows = []; let row = [], f = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else inQ = false; } else f += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const cmd = process.argv[2];
if (cmd === 'export') {
  const af = require('../lang/af.json').phrases;
  const out = [['English', 'Afrikaans (reference)', 'Oshiwambo', 'Otjiherero', 'Khoekhoegowab', 'German'].map(q).join(',')];
  for (const [en, a] of Object.entries(af)) out.push([en, a, '', '', '', ''].map(q).join(','));
  process.stdout.write('﻿' + out.join('\r\n') + '\r\n');
} else if (cmd === 'import') {
  const rows = parse(fs.readFileSync(process.argv[3], 'utf8').replace(/^﻿/, ''));
  const head = rows.shift().map((h) => h.toLowerCase());
  const idx = {};
  for (const [key, code] of Object.entries(LANGS)) { const i = head.findIndex((h) => h.startsWith(key)); if (i > -1) idx[code] = i; }
  const index = JSON.parse(fs.readFileSync(path.join(langDir, 'index.json'), 'utf8'));
  for (const [code, i] of Object.entries(idx)) {
    const phrases = {};
    rows.forEach((r) => { if (r[0] && r[i] && r[i].trim()) phrases[r[0]] = r[i].trim(); });
    const n = Object.keys(phrases).length;
    if (!n) continue;
    fs.writeFileSync(path.join(langDir, code + '.json'), JSON.stringify({ code, name: NAMES[code], phrases, patterns: [] }, null, 1));
    if (!index.find((l) => l.code === code)) index.push({ code, name: NAMES[code] });
    console.log(code, NAMES[code], n, 'phrases');
  }
  fs.writeFileSync(path.join(langDir, 'index.json'), JSON.stringify(index, null, 1));
} else { console.log('usage: export | import <file.csv>'); process.exit(1); }
