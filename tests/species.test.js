const { test } = require('node:test');
const assert = require('node:assert');
const { request, app, registerFarmer } = require('./helpers');
const { normaliseSpecies } = require('../src/utils/herdValue');

test('species names are tidied, and any animal can be recorded', () => {
  assert.strictEqual(normaliseSpecies('pigs'), 'Pig');
  assert.strictEqual(normaliseSpecies('  HORSES '), 'Horse');
  assert.strictEqual(normaliseSpecies('Goats'), 'Goat');
  assert.strictEqual(normaliseSpecies('guinea fowl'), 'Guinea Fowl');
  assert.strictEqual(normaliseSpecies(''), null);
  assert.strictEqual(normaliseSpecies('x'.repeat(41)), null);
});

test('a farmer can record pigs, horses and other animals, and see them separately', async () => {
  const farmer = await registerFarmer();
  const auth = { Authorization: `Bearer ${farmer.token}` };

  const pig = await request(app).post('/api/v1/animals').set(auth)
    .send({ tag_number: 'PIG-1', species: 'pigs', class: 'Sow' });
  assert.strictEqual(pig.status, 201, JSON.stringify(pig.body));
  assert.strictEqual(pig.body.animal.species, 'Pig');

  const guinea = await request(app).post('/api/v1/animals').set(auth)
    .send({ tag_number: 'GF-1', species: 'guinea fowl' });
  assert.strictEqual(guinea.status, 201, JSON.stringify(guinea.body));
  assert.strictEqual(guinea.body.animal.species, 'Guinea Fowl');

  const bad = await request(app).post('/api/v1/animals').set(auth)
    .send({ tag_number: 'BAD-1', species: '' });
  assert.strictEqual(bad.status, 400);

  const patch = await request(app).patch(`/api/v1/animals/${pig.body.animal.animal_id}`).set(auth)
    .send({ species: '' });
  assert.strictEqual(patch.status, 400);
});

test('prices work for a new species, and an unclassified animal uses the adult class', async () => {
  const farmer = await registerFarmer();
  const auth = { Authorization: `Bearer ${farmer.token}` };
  await request(app).post('/api/v1/animals').set(auth).send({ tag_number: 'P-1', species: 'Pig', class: 'Sow' });
  await request(app).post('/api/v1/animals').set(auth).send({ tag_number: 'P-2', species: 'Pig', class: 'Sow' });
  await request(app).post('/api/v1/animals').set(auth).send({ tag_number: 'H-1', species: 'Horse' }); // no class: a mare

  const put = await request(app).put('/api/v1/valuation/prices').set(auth).send({ prices: [
    { species: 'Pig', class: 'Sow', price: 1000 },
    { species: 'Horse', class: 'Mare', price: 5000 },
  ] });
  assert.strictEqual(put.status, 200, JSON.stringify(put.body));

  const v = await request(app).get('/api/v1/valuation').set(auth);
  assert.strictEqual(v.body.live_herd.total_estimated_value, 2 * 1000 + 5000);
  assert.strictEqual(v.body.live_herd.assumed_class_count, 1);
});

test('performance lists every species on the farm', async () => {
  const farmer = await registerFarmer();
  const auth = { Authorization: `Bearer ${farmer.token}` };
  const sow = await request(app).post('/api/v1/animals').set(auth).send({ tag_number: 'S-1', species: 'Pig', class: 'Sow' });
  await request(app).post('/api/v1/events').set(auth)
    .send({ animal_id: sow.body.animal.animal_id, event_type: 'Born', event_date: '2026-05-01' });
  await request(app).post('/api/v1/animals').set(auth).send({ tag_number: 'H-2', species: 'Donkey', class: 'Jenny' });

  const res = await request(app).get('/api/v1/valuation/performance?from=2026-01-01&to=2026-12-31').set(auth);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.by_species.Pig.births, 1);
  assert.strictEqual(res.body.by_species.Pig.breeding_females, 1);
  assert.strictEqual(res.body.by_species.Donkey.breeding_females, 1);
  assert.deepStrictEqual(Object.keys(res.body.by_species), ['Donkey', 'Pig']);
});
