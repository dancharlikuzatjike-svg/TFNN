const { test } = require('node:test');
const assert = require('node:assert');
const { request, app, registerFarmer } = require('./helpers');

test('correcting a count or species needs a reason and is written into the history', async () => {
  const farmer = await registerFarmer();
  const auth = { Authorization: `Bearer ${farmer.token}` };
  const flock = await request(app).post('/api/v1/animals').set(auth)
    .send({ tag_number: 'COR-1', species: 'Chicken', class: 'Hen', head_count: 200 });
  const id = flock.body.animal.animal_id;

  const noReason = await request(app).patch(`/api/v1/animals/${id}`).set(auth).send({ head_count: 150 });
  assert.strictEqual(noReason.status, 400);

  const ok = await request(app).patch(`/api/v1/animals/${id}`).set(auth)
    .send({ head_count: 150, reason: 'Counted again on Sunday' });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.strictEqual(ok.body.animal.head_count, 150);

  const fixSpecies = await request(app).patch(`/api/v1/animals/${id}`).set(auth)
    .send({ species: 'Guinea Fowl', reason: 'Entered the wrong species' });
  assert.strictEqual(fixSpecies.status, 200);

  const timeline = await request(app).get(`/api/v1/animals/${id}/events`).set(auth);
  const notes = (timeline.body.events || []).map((e) => e.notes);
  assert.ok(notes.some((n) => n && n.includes('head count 200 → 150') && n.includes('Counted again on Sunday')), JSON.stringify(notes));
  assert.ok(notes.some((n) => n && n.includes('species Chicken → Guinea Fowl')));

  // a correction is not a death, so the performance card does not count it
  const perf = await request(app).get('/api/v1/valuation/performance?from=2026-01-01&to=2026-12-31').set(auth);
  assert.strictEqual(perf.body.deaths.count, 0);
  assert.strictEqual(perf.body.births.count, 0);
});

test('saving a correction with the same values changes nothing and needs no reason', async () => {
  const farmer = await registerFarmer();
  const auth = { Authorization: `Bearer ${farmer.token}` };
  const a = await request(app).post('/api/v1/animals').set(auth).send({ tag_number: 'SAME-1', species: 'Goat' });
  const res = await request(app).patch(`/api/v1/animals/${a.body.animal.animal_id}`).set(auth)
    .send({ species: 'Goat', head_count: 1 });
  assert.strictEqual(res.status, 200);
});
