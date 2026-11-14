const { test } = require('node:test');
const assert = require('node:assert');
const { request, app, registerFarmer } = require('./helpers');

async function addAnimal(farmer, tag, extra = {}) {
  const res = await request(app)
    .post('/api/v1/animals')
    .set('Authorization', `Bearer ${farmer.token}`)
    .send({ tag_number: tag, species: 'Goat', ...extra });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return res.body.animal;
}

test('performance counts births, deaths, sales and expenses for a window', async () => {
  const farmer = await registerFarmer();
  const auth = { Authorization: `Bearer ${farmer.token}` };
  const doe1 = await addAnimal(farmer, 'PERF-D1', { class: 'Doe' });
  const doe2 = await addAnimal(farmer, 'PERF-D2', { class: 'Doe' });
  const kid = await addAnimal(farmer, 'PERF-K1', { class: 'Kid' });
  await addAnimal(farmer, 'PERF-X1'); // no class: not counted as a breeding female

  const ev = (animal, event_type, event_date) => request(app).post('/api/v1/events').set(auth)
    .send({ animal_id: animal.animal_id, event_type, event_date });
  assert.strictEqual((await ev(doe1, 'Born', '2026-03-10')).status, 201);
  assert.strictEqual((await ev(doe2, 'Born', '2026-03-12')).status, 201);
  assert.strictEqual((await ev(kid, 'Died', '2026-03-20')).status, 201);
  assert.strictEqual((await ev(doe1, 'Born', '2025-03-10')).status, 201); // outside the window

  const sale = await request(app).post('/api/v1/sales').set(auth)
    .send({ animal_id: doe2.animal_id, buyer_name: 'Buyer', price: 3000, sale_date: '2026-04-01' });
  assert.strictEqual(sale.status, 201, JSON.stringify(sale.body));
  const exp = await request(app).post('/api/v1/expenses').set(auth)
    .send({ amount: 500, category: 'Feed', expense_date: '2026-04-02' });
  assert.strictEqual(exp.status, 201, JSON.stringify(exp.body));

  const res = await request(app).get('/api/v1/valuation/performance?from=2026-01-01&to=2026-12-31').set(auth);
  assert.strictEqual(res.status, 200);
  const p = res.body;
  // doe2 was sold, so only doe1 is still an active breeding female
  assert.strictEqual(p.herd.breeding_females, 1);
  assert.strictEqual(p.births.count, 2);
  assert.strictEqual(p.births.per_100_females, 200);
  assert.strictEqual(p.deaths.count, 1);
  assert.strictEqual(p.deaths.young, 1);
  assert.strictEqual(p.money.income, 3000);
  assert.strictEqual(p.money.expenses, 500);
  assert.strictEqual(p.money.net, 2500);
  // split by species: the goats carry all the births and the young death
  assert.strictEqual(p.by_species.Goat.breeding_females, 1);
  assert.strictEqual(p.by_species.Goat.births, 2);
  assert.strictEqual(p.by_species.Goat.young_deaths, 1);
  // no cattle on this farm, so cattle does not appear at all
  assert.strictEqual(p.by_species.Cattle, undefined);
});

test('performance with no animals returns nulls rather than dividing by zero', async () => {
  const farmer = await registerFarmer();
  const res = await request(app).get('/api/v1/valuation/performance')
    .set('Authorization', `Bearer ${farmer.token}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.births.per_100_females, null);
  assert.strictEqual(res.body.money.net_per_animal, null);
});
