const { test } = require('node:test');
const assert = require('node:assert');
const { request, app, registerFarmer } = require('./helpers');

async function setup() {
  const farmer = await registerFarmer();
  const auth = { Authorization: `Bearer ${farmer.token}` };
  const flock = await request(app).post('/api/v1/animals').set(auth)
    .send({ tag_number: 'FLOCK-HENS', species: 'Chicken', class: 'Hen', head_count: 200 });
  assert.strictEqual(flock.status, 201, JSON.stringify(flock.body));
  assert.strictEqual(flock.body.animal.head_count, 200);
  const put = await request(app).put('/api/v1/valuation/prices').set(auth)
    .send({ prices: [{ species: 'Chicken', class: 'Hen', price: 10 }] });
  assert.strictEqual(put.status, 200);
  return { farmer, auth, flockId: flock.body.animal.animal_id };
}

test('a flock counts as many animals and is valued per head', async () => {
  const { auth } = await setup();
  const v = await request(app).get('/api/v1/valuation').set(auth);
  assert.strictEqual(v.body.live_herd.animal_count, 200);
  assert.strictEqual(v.body.live_herd.total_estimated_value, 2000);
});

test('births and deaths with a count change the flock, and deaths are counted', async () => {
  const { auth, flockId } = await setup();
  const born = await request(app).post('/api/v1/events').set(auth)
    .send({ animal_id: flockId, event_type: 'Born', event_date: '2026-06-01', count: 50 });
  assert.strictEqual(born.status, 201, JSON.stringify(born.body));
  const died = await request(app).post('/api/v1/events').set(auth)
    .send({ animal_id: flockId, event_type: 'Died', event_date: '2026-06-02', count: 30 });
  assert.strictEqual(died.status, 201, JSON.stringify(died.body));

  const animal = await request(app).get(`/api/v1/animals/${flockId}`).set(auth);
  assert.strictEqual(animal.body.animal.head_count, 220);

  const perf = await request(app).get('/api/v1/valuation/performance?from=2026-01-01&to=2026-12-31').set(auth);
  assert.strictEqual(perf.body.births.count, 50);
  assert.strictEqual(perf.body.deaths.count, 30);
  assert.strictEqual(perf.body.by_species.Chicken.births, 50);
  assert.strictEqual(perf.body.by_species.Chicken.deaths, 30);
});

test('a flock cannot lose more birds than it has, and is Deceased when empty', async () => {
  const { auth, flockId } = await setup();
  const tooMany = await request(app).post('/api/v1/events').set(auth)
    .send({ animal_id: flockId, event_type: 'Died', event_date: '2026-06-02', count: 999 });
  assert.strictEqual(tooMany.status, 400);

  const all = await request(app).post('/api/v1/events').set(auth)
    .send({ animal_id: flockId, event_type: 'Died', event_date: '2026-06-03', count: 200 });
  assert.strictEqual(all.status, 201);
  const animal = await request(app).get(`/api/v1/animals/${flockId}`).set(auth);
  assert.strictEqual(animal.body.animal.head_count, 0);
  assert.strictEqual(animal.body.animal.status, 'Deceased');
});

test('count is rejected on other events, and a bad head count is rejected', async () => {
  const { auth, flockId } = await setup();
  const vacc = await request(app).post('/api/v1/events').set(auth)
    .send({ animal_id: flockId, event_type: 'Vaccinated', event_date: '2026-06-01', count: 5 });
  assert.strictEqual(vacc.status, 400);

  const bad = await request(app).post('/api/v1/animals').set(auth)
    .send({ tag_number: 'BAD-HEADS', species: 'Pig', head_count: 0 });
  assert.strictEqual(bad.status, 400);
});

test('a single animal still counts as one when a birth is logged without a count', async () => {
  const farmer = await registerFarmer();
  const auth = { Authorization: `Bearer ${farmer.token}` };
  const kid = await request(app).post('/api/v1/animals').set(auth).send({ tag_number: 'KID-1', species: 'Goat', class: 'Kid' });
  await request(app).post('/api/v1/events').set(auth)
    .send({ animal_id: kid.body.animal.animal_id, event_type: 'Born', event_date: '2026-06-01' });
  const perf = await request(app).get('/api/v1/valuation/performance?from=2026-01-01&to=2026-12-31').set(auth);
  assert.strictEqual(perf.body.births.count, 1);
  assert.strictEqual(perf.body.herd.active, 1);
});
