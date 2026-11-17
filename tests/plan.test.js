const { test } = require('node:test');
const assert = require('node:assert');
const { request, app, registerFarmer } = require('./helpers');
const { PLAN, CATEGORIES, SPECIES } = require('../src/utils/yearPlan');

const auth = (f) => ({ Authorization: `Bearer ${f.token}` });
const addAnimal = (f, body) => request(app).post('/api/v1/animals').set(auth(f)).send(body);
const titlesFor = (plan, month) => plan.months[month - 1].items.map((i) => i.title);

test('the year plan data is well formed and never gives a dose amount', () => {
  const ids = new Set();
  for (const p of PLAN) {
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
    assert.ok(CATEGORIES.includes(p.category), p.id);
    assert.ok(p.species.length && p.species.every((s) => SPECIES.includes(s)), p.id);
    assert.ok(p.months.length && p.months.every((m) => Number.isInteger(m) && m >= 1 && m <= 12), p.id);
    assert.ok(p.title.length > 5 && p.title.length <= 150, `${p.id} title length`);
    assert.ok(!/\b\d+(\.\d+)?\s?(ml|mg|cc|g\/kg|mg\/kg|ml\/kg)\b/i.test(p.title + ' ' + p.note), `${p.id} looks like a dose`);
  }
});

test('a cattle farm sees cattle jobs only; a goat farm sees small-stock jobs only', async () => {
  const cattle = await registerFarmer();
  await addAnimal(cattle, { tag_number: 'P-C1', species: 'Cattle', class: 'Cow' });
  const c = await request(app).get('/api/v1/plan').set(auth(cattle));
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));
  assert.deepStrictEqual(c.body.species, ['Cattle']);
  assert.strictEqual(c.body.months.length, 12);
  assert.ok(titlesFor(c.body, 1).some((t) => t.startsWith('Dip or spray every 2 weeks')));
  assert.ok(titlesFor(c.body, 9).some((t) => t.startsWith('Dip or spray every 3 weeks')));
  assert.ok(!titlesFor(c.body, 1).some((t) => t.includes('FAMACHA')));
  assert.ok(titlesFor(c.body, 9).some((t) => t.startsWith('Anthrax')));

  const goats = await registerFarmer();
  await addAnimal(goats, { tag_number: 'P-G1', species: 'goats', class: 'Doe' });
  const g = await request(app).get('/api/v1/plan').set(auth(goats));
  assert.deepStrictEqual(g.body.species, ['Goat']);
  assert.ok(titlesFor(g.body, 1).some((t) => t.includes('FAMACHA')));
  assert.ok(!titlesFor(g.body, 1).some((t) => t.startsWith('Dip or spray')));
  assert.ok(titlesFor(g.body, 12).some((t) => t.startsWith('Put rams and bucks')));
});

test('a farm with sheep and cattle sees both sets', async () => {
  const f = await registerFarmer();
  await addAnimal(f, { tag_number: 'P-M1', species: 'Cattle', class: 'Cow' });
  await addAnimal(f, { tag_number: 'P-M2', species: 'Sheep', class: 'Ewe' });
  const r = await request(app).get('/api/v1/plan').set(auth(f));
  assert.deepStrictEqual(r.body.species, ['Cattle', 'Sheep']);
  assert.ok(titlesFor(r.body, 2).some((t) => t.startsWith('Dip or spray')));
  assert.ok(titlesFor(r.body, 2).some((t) => t.includes('FAMACHA')));
});

test('a new farm with no animals sees the whole plan, and other species get an empty plan', async () => {
  const fresh = await registerFarmer();
  const r = await request(app).get('/api/v1/plan').set(auth(fresh));
  assert.strictEqual(r.body.has_herd, false);
  assert.strictEqual(r.body.showing_all, true);
  assert.ok(titlesFor(r.body, 1).some((t) => t.startsWith('Dip or spray')));
  assert.ok(titlesFor(r.body, 1).some((t) => t.includes('FAMACHA')));

  const pigs = await registerFarmer();
  await addAnimal(pigs, { tag_number: 'P-PIG', species: 'Pig', class: 'Sow' });
  const p = await request(app).get('/api/v1/plan').set(auth(pigs));
  assert.strictEqual(p.body.has_herd, true);
  assert.deepStrictEqual(p.body.species, []);
  assert.ok(p.body.months.every((m) => m.items.length === 0));
});

test('add-month puts the jobs in Tasks once, and rejects a bad month', async () => {
  const f = await registerFarmer();
  await addAnimal(f, { tag_number: 'P-T1', species: 'Cattle', class: 'Cow' });
  const month = new Date().getUTCMonth() + 1;
  const first = await request(app).post('/api/v1/plan/add-month').set(auth(f)).send({});
  assert.strictEqual(first.status, 200, JSON.stringify(first.body));
  assert.strictEqual(first.body.month, month);
  assert.ok(first.body.added.length > 0);
  const second = await request(app).post('/api/v1/plan/add-month').set(auth(f)).send({ month });
  assert.deepStrictEqual(second.body.added, []);

  const list = await request(app).get('/api/v1/tasks?done=false').set(auth(f));
  const planTasks = list.body.tasks.filter((t) => t.source === 'plan');
  assert.strictEqual(planTasks.length, first.body.added.length);

  assert.strictEqual((await request(app).post('/api/v1/plan/add-month').set(auth(f)).send({ month: 13 })).status, 400);
  assert.strictEqual((await request(app).post('/api/v1/plan/add-month').set(auth(f)).send({ month: 'x' })).status, 400);
});

test('add-month for a month already past is due next year; with no covered animals nothing is added', async () => {
  const f = await registerFarmer();
  await addAnimal(f, { tag_number: 'P-Y1', species: 'Sheep', class: 'Ewe' });
  const nowMonth = new Date().getUTCMonth() + 1;
  if (nowMonth > 1) {
    const r = await request(app).post('/api/v1/plan/add-month').set(auth(f)).send({ month: 1 });
    assert.ok(String(r.body.due).startsWith(String(new Date().getUTCFullYear() + 1)), JSON.stringify(r.body));
  }
  const none = await registerFarmer();
  await addAnimal(none, { tag_number: 'P-N1', species: 'Pig', class: 'Sow' });
  const n = await request(app).post('/api/v1/plan/add-month').set(auth(none)).send({});
  assert.deepStrictEqual(n.body.added, []);
});

test('the plan needs a login', async () => {
  assert.strictEqual((await request(app).get('/api/v1/plan')).status, 401);
  assert.strictEqual((await request(app).post('/api/v1/plan/add-month').send({})).status, 401);
});
