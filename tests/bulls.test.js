const { test } = require('node:test');
const assert = require('node:assert');
const { request, app, registerFarmer } = require('./helpers');

const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function animal(token, body) {
  const r = await request(app).post('/api/v1/animals').set('Authorization', `Bearer ${token}`).send(body);
  assert.strictEqual(r.status, 201);
  return r.body.animal.animal_id;
}
async function ev(token, animal_id, event_type, date, metadata) {
  const r = await request(app).post('/api/v1/events').set('Authorization', `Bearer ${token}`).send({ animal_id, event_type, event_date: date, metadata });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
}
const getBulls = (token) => request(app).get('/api/v1/bulls').set('Authorization', `Bearer ${token}`);

test('bull care: new bull is flagged, then healthy once exam, vaccination, dosing and condition are logged', async () => {
  const f = await registerFarmer();
  const bull = await animal(f.token, { tag_number: 'B-1', species: 'Cattle', class: 'Bull', date_of_birth: '2020-01-01' });
  let r = await getBulls(f.token);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.bulls.length, 1);
  assert.strictEqual(r.body.bulls[0].bse.status, 'none');
  assert.strictEqual(r.body.bulls[0].status, 'warn');

  await ev(f.token, bull, 'Breeding Soundness Exam', day(20), { result: 'Pass' });
  await ev(f.token, bull, 'Vaccinated', day(30));
  await ev(f.token, bull, 'Dosed / Dewormed', day(30));
  await ev(f.token, bull, 'Body Condition Score', day(10), { score: 6 });
  r = await getBulls(f.token);
  const b = r.body.bulls[0];
  assert.strictEqual(b.bse.status, 'ok');
  assert.strictEqual(b.body_condition, 6);
  assert.strictEqual(b.status, 'ok');
  assert.deepStrictEqual(b.alerts, []);
});

test('bull care: overdue/failed exam, thin condition and too long with the cows are flagged', async () => {
  const f = await registerFarmer();
  const old = await animal(f.token, { tag_number: 'B-OLD', species: 'Cattle', class: 'Bull', date_of_birth: '2019-01-01' });
  await ev(f.token, old, 'Breeding Soundness Exam', day(400), { result: 'Pass' });
  const failed = await animal(f.token, { tag_number: 'B-FAIL', species: 'Cattle', class: 'Bull', date_of_birth: '2019-01-01' });
  await ev(f.token, failed, 'Breeding Soundness Exam', day(5), { result: 'Fail' });
  await ev(f.token, failed, 'Body Condition Score', day(5), { score: 3 });
  await ev(f.token, failed, 'Joined Herd', day(100));

  const r = await getBulls(f.token);
  const byTag = Object.fromEntries(r.body.bulls.map((b) => [b.tag_number, b]));
  assert.strictEqual(byTag['B-OLD'].bse.status, 'overdue');
  assert.strictEqual(byTag['B-FAIL'].bse.status, 'failed');
  assert.strictEqual(byTag['B-FAIL'].status, 'bad');
  assert.strictEqual(byTag['B-FAIL'].with_herd, true);
  assert.ok(byTag['B-FAIL'].alerts.some((a) => /with the cows/.test(a.text)));
  assert.ok(byTag['B-FAIL'].alerts.some((a) => /thin/.test(a.text)));

  // taking him out ends the joined period and starts the rest period
  await ev(f.token, failed, 'Removed from Herd', day(2));
  const r2 = await getBulls(f.token);
  const f2 = r2.body.bulls.find((b) => b.tag_number === 'B-FAIL');
  assert.strictEqual(f2.with_herd, false);
  assert.ok(f2.alerts.some((a) => /Resting/.test(a.text)));
});

test('bull care: bull-to-cow guidance and isolation between farmers', async () => {
  const f = await registerFarmer();
  await animal(f.token, { tag_number: 'B-1', species: 'Cattle', class: 'Bull', date_of_birth: '2019-01-01' });
  for (let i = 0; i < 30; i++) await animal(f.token, { tag_number: 'C-' + i, species: 'Cattle', class: 'Cow' });
  const r = await getBulls(f.token);
  assert.strictEqual(r.body.herd.breeding_females, 30);
  assert.strictEqual(r.body.herd.bulls_needed, 2);
  assert.match(r.body.herd.message, /more than your bulls can cover/);

  const other = await registerFarmer();
  const r2 = await getBulls(other.token);
  assert.strictEqual(r2.body.bulls.length, 0);
  assert.strictEqual((await request(app).get('/api/v1/bulls')).status, 401);
});
