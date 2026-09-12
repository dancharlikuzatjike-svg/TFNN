const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('farmer portal production files are present', () => {
  for (const file of ['public/index.html', 'public/styles.css', 'public/app.js', 'public/sw.js', 'public/manifest.webmanifest']) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} is missing`);
  }
});

test('every JavaScript ID selector exists in the portal markup', () => {
  const html = read('public/index.html');
  const javascript = read('public/app.js');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const selectors = new Set([...javascript.matchAll(/\$\("#([A-Za-z][\w-]*)"\)/g)].map(match => match[1]));
  assert.deepEqual([...selectors].filter(id => !ids.has(id)), []);
});

test('portal is connected to authenticated owner-scoped animal routes', () => {
  const frontend = read('public/app.js');
  const backend = read('src/routes/animals.js');
  assert.match(frontend, /Authorization: `Bearer/);
  assert.match(frontend, /\/api\/v1\/animals/);
  assert.match(backend, /owner_id = \$1/);
  assert.match(backend, /requireAuth/);
});

test('Bull, Ram and Buck are the only breeding-male classes', () => {
  const frontend = read('public/app.js');
  const backend = read('src/routes/animals.js');
  for (const source of [frontend, backend]) {
    assert.match(source, /Cattle: ['"]Bull['"]/);
    assert.match(source, /Sheep: ['"]Ram['"]/);
    assert.match(source, /Goat: ['"]Buck['"]/);
  }
});

test('database migration includes the new record-detail fields', () => {
  const migration = read('sql/002_animal_record_details.sql');
  for (const column of ['sex', 'stock_brand', 'registration_status', 'health_status', 'condition_score', 'updated_at']) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
});
