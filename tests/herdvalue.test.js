const { test } = require('node:test');
const assert = require('node:assert');
const { request, app, registerFarmer } = require('./helpers');
const db = require('../src/db');

const auth = (f) => ({ Authorization: `Bearer ${f.token}` });
async function addAnimal(farmer, tag, cls, species = 'Cattle') {
  const res = await request(app).post('/api/v1/animals').set(auth(farmer)).send({ tag_number: tag, species, class: cls });
  assert.strictEqual(res.status, 201);
  return res.body.animal;
}
const valuation = async (f) => (await request(app).get('/api/v1/valuation').set(auth(f))).body.live_herd;
const setPrices = (f, prices) => request(app).put('/api/v1/valuation/prices').set(auth(f)).send({ prices });

test('a class price values every animal in that class', async () => {
  const farmer = await registerFarmer();
  await addAnimal(farmer, 'HV-1', 'Cow');
  await addAnimal(farmer, 'HV-2', 'Cow');
  await addAnimal(farmer, 'HV-3', 'Bull');

  let live = await valuation(farmer);
  assert.strictEqual(live.unpriced_count, 3);

  const put = await setPrices(farmer, [{ species: 'Cattle', class: 'Cow', price: 12000 }]);
  assert.strictEqual(put.status, 200);

  live = await valuation(farmer);
  assert.strictEqual(live.total_estimated_value, 24000);
  assert.strictEqual(live.unpriced_count, 1);

  const prices = (await request(app).get('/api/v1/valuation/prices').set(auth(farmer))).body.prices;
  const cow = prices.find((p) => p.class === 'Cow');
  assert.strictEqual(cow.animal_count, 2);
  assert.strictEqual(cow.price, 12000);
  assert.ok(prices.find((p) => p.class === 'Bull' && p.price === null));

  const list = (await request(app).get('/api/v1/animals').set(auth(farmer))).body.animals;
  const a = list.find((x) => x.tag_number === 'HV-1');
  assert.strictEqual(Number(a.value), 12000);
  assert.strictEqual(a.value_source, 'class');
});

test("an animal's own value beats the class price, and clearing it goes back", async () => {
  const farmer = await registerFarmer();
  const bull = await addAnimal(farmer, 'HV-10', 'Bull');
  await addAnimal(farmer, 'HV-11', 'Bull');
  await setPrices(farmer, [{ species: 'Cattle', class: 'Bull', price: 20000 }]);

  let res = await request(app).patch(`/api/v1/animals/${bull.animal_id}`).set(auth(farmer)).send({ estimated_value: 65000 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await valuation(farmer)).total_estimated_value, 85000);

  res = await request(app).patch(`/api/v1/animals/${bull.animal_id}`).set(auth(farmer)).send({ estimated_value: null });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await valuation(farmer)).total_estimated_value, 40000);

  res = await request(app).patch(`/api/v1/animals/${bull.animal_id}`).set(auth(farmer)).send({ estimated_value: 'lots' });
  assert.strictEqual(res.status, 400);
});

test('animals with no class can be priced, and a price can be removed', async () => {
  const farmer = await registerFarmer();
  await addAnimal(farmer, 'HV-20', undefined, 'Goat');
  await setPrices(farmer, [{ species: 'Goat', class: '', price: 1500 }]);
  assert.strictEqual((await valuation(farmer)).total_estimated_value, 1500);
  await setPrices(farmer, [{ species: 'Goat', class: '', price: null }]);
  const live = await valuation(farmer);
  assert.strictEqual(live.total_estimated_value, 0);
  assert.strictEqual(live.unpriced_count, 1);
});

test("one farmer's prices never affect another farmer", async () => {
  const a = await registerFarmer();
  const b = await registerFarmer();
  await addAnimal(a, 'HV-30', 'Wether', 'Sheep');
  await addAnimal(b, 'HV-30', 'Wether', 'Sheep');
  await setPrices(a, [{ species: 'Sheep', class: 'Wether', price: 1800 }]);
  assert.strictEqual((await valuation(a)).total_estimated_value, 1800);
  assert.strictEqual((await valuation(b)).unpriced_count, 1);
});

test('bad prices are rejected', async () => {
  const farmer = await registerFarmer();
  assert.strictEqual((await setPrices(farmer, [{ species: 'Cattle', class: 'Cow', price: -5 }])).status, 400);
  assert.strictEqual((await setPrices(farmer, [{ species: 'Horse', class: 'Mare', price: 5 }])).status, 400);
  assert.strictEqual((await setPrices(farmer, [])).status, 400);
  assert.strictEqual((await request(app).get('/api/v1/valuation/prices')).status, 401);
});

test('market reference prices fill in when the farmer has no price, via the job endpoint and admin', async () => {
  // 'Kid' goats are used so this does not disturb the other tests' classes
  const farmer = await registerFarmer();
  await addAnimal(farmer, 'HV-40', 'Kid', 'Goat');

  process.env.CRON_SECRET = 'test-cron-secret';
  const bad = await request(app).post('/api/v1/jobs/market-prices').set('x-cron-secret', 'wrong').send({ prices: [{ species: 'Goat', class: 'Kid', price: 900 }] });
  assert.strictEqual(bad.status, 401);
  const ok = await request(app).post('/api/v1/jobs/market-prices').set('x-cron-secret', 'test-cron-secret')
    .send({ prices: [{ species: 'Goat', class: 'Kid', price: 900, source: 'test auction' }] });
  assert.strictEqual(ok.status, 200);

  let live = await valuation(farmer);
  assert.strictEqual(live.total_estimated_value, 900);
  assert.strictEqual(live.market_priced_count, 1);

  // the farmer's own class price wins over the market price
  await setPrices(farmer, [{ species: 'Goat', class: 'Kid', price: 1100 }]);
  live = await valuation(farmer);
  assert.strictEqual(live.total_estimated_value, 1100);
  assert.strictEqual(live.market_priced_count, 0);

  // farmers cannot touch market prices; admins can
  assert.strictEqual((await request(app).put('/api/v1/admin/market-prices').set(auth(farmer)).send({ prices: [{ species: 'Goat', class: 'Kid', price: 1 }] })).status, 403);
  await db.query(`UPDATE users SET role = 'admin' WHERE phone = $1`, [farmer.phone]);
  const login = await request(app).post('/api/v1/auth/login').send({ phone: farmer.phone, password: farmer.password });
  const admin = { token: login.body.token };
  const list = await request(app).get('/api/v1/admin/market-prices').set(auth(admin));
  assert.ok(list.body.prices.find((p) => p.species === 'Goat' && p.class === 'Kid' && p.price === 900));
  const del = await request(app).put('/api/v1/admin/market-prices').set(auth(admin)).send({ prices: [{ species: 'Goat', class: 'Kid', price: null }] });
  assert.strictEqual(del.status, 200);
  assert.ok(!del.body.prices.find((p) => p.species === 'Goat' && p.class === 'Kid'));
});

test('the statement uses the same herd value as the Value tab', async () => {
  const farmer = await registerFarmer();
  await addAnimal(farmer, 'HV-50', 'Ram', 'Sheep');
  await setPrices(farmer, [{ species: 'Sheep', class: 'Ram', price: 4000 }]);
  const st = await request(app).get('/api/v1/statement?format=json').set(auth(farmer));
  assert.strictEqual(st.status, 200);
  assert.strictEqual(Number(st.body.live_herd[0].estimated_value), 4000);
});
