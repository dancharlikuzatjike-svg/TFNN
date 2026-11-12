const { test } = require('node:test');
const assert = require('node:assert');
const { request, app, registerFarmer } = require('./helpers');
const db = require('../src/db');

process.env.CRON_SECRET = 'test-cron-secret';
const auth = (u) => ({ Authorization: `Bearer ${u.token}` });
const submit = (body) => request(app).post('/api/v1/jobs/market-price-proposals').set('x-cron-secret', 'test-cron-secret').send(body);
async function makeAdmin() {
  const u = await registerFarmer();
  await db.query(`UPDATE users SET role = 'admin' WHERE phone = $1`, [u.phone]);
  const login = await request(app).post('/api/v1/auth/login').send({ phone: u.phone, password: u.password });
  return { token: login.body.token };
}
// These tests share the market price tables, so each one uses its own classes and cleans them first.
async function clean(species, classes) {
  await db.query('DELETE FROM price_proposal WHERE species = $1 AND class = ANY($2)', [species, classes]);
  await db.query('DELETE FROM reference_price WHERE species = $1 AND class = ANY($2)', [species, classes]);
  await db.query('DELETE FROM class_weight WHERE species = $1 AND class = ANY($2)', [species, classes]);
}
const pendingFor = async (admin, species, cls) =>
  (await request(app).get('/api/v1/admin/price-proposals').set(auth(admin))).body.proposals.find((p) => p.species === species && p.class === cls);

test('agent quotes wait for approval, then go live and value a farmer herd', async () => {
  await clean('Cattle', ['Steer', 'Heifer']);
  const admin = await makeAdmin();
  const farmer = await registerFarmer();
  await request(app).post('/api/v1/animals').set(auth(farmer)).send({ tag_number: 'PA-1', species: 'Cattle', class: 'Steer' });

  assert.strictEqual((await request(app).post('/api/v1/jobs/market-price-proposals').send({ items: [] })).status, 401);
  const res = await submit({ source: 'LLPB weekly report', items: [
    { species: 'Cattle', class: 'Steer', basis: 'kg', price: 36 },        // 36 x 400 kg = 14 400
    { species: 'Cattle', class: 'Heifer', basis: 'head', price: 9500 },
    { species: 'Cattle', class: 'Unicorn', basis: 'kg', price: 10 },
    { species: 'Cattle', class: 'Cow', basis: 'tonne', price: 10 },
  ] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.result.pending, 2);
  assert.strictEqual(res.body.result.skipped.length, 2);

  // nothing is live until approved
  let live = (await request(app).get('/api/v1/valuation').set(auth(farmer))).body.live_herd;
  assert.strictEqual(live.total_estimated_value, 0);

  const steer = await pendingFor(admin, 'Cattle', 'Steer');
  assert.strictEqual(steer.price, 14400);
  assert.strictEqual(steer.weight_kg, 400);
  assert.strictEqual(steer.flag_reason, null);

  const farmerTry = await request(app).post('/api/v1/admin/price-proposals/decide').set(auth(farmer)).send({ ids: [steer.proposal_id], action: 'approve' });
  assert.strictEqual(farmerTry.status, 403);
  const ok = await request(app).post('/api/v1/admin/price-proposals/decide').set(auth(admin)).send({ ids: [steer.proposal_id], action: 'approve' });
  assert.strictEqual(ok.body.result.decided, 1);

  live = (await request(app).get('/api/v1/valuation').set(auth(farmer))).body.live_herd;
  assert.strictEqual(live.total_estimated_value, 14400);
  assert.strictEqual(live.market_priced_count, 1);

  const heifer = await pendingFor(admin, 'Cattle', 'Heifer');
  await request(app).post('/api/v1/admin/price-proposals/decide').set(auth(admin)).send({ ids: [heifer.proposal_id], action: 'reject' });
  const prices = (await request(app).get('/api/v1/admin/market-prices').set(auth(admin))).body.prices;
  assert.ok(!prices.find((p) => p.species === 'Cattle' && p.class === 'Heifer'));
});

test('big jumps and impossible prices are flagged, and a newer quote replaces an older pending one', async () => {
  await clean('Sheep', ['Lamb', 'Ram']);
  const admin = await makeAdmin();
  await request(app).put('/api/v1/admin/market-prices').set(auth(admin)).send({ prices: [{ species: 'Sheep', class: 'Lamb', price: 1400 }] });

  await submit({ items: [{ species: 'Sheep', class: 'Lamb', basis: 'kg', price: 41 }] }); // 41 x 35 = 1 435, +2.5%
  assert.strictEqual((await pendingFor(admin, 'Sheep', 'Lamb')).flag_reason, null);

  const res = await submit({ items: [
    { species: 'Sheep', class: 'Lamb', basis: 'kg', price: 410 },   // misread decimal: 14 350 per head
    { species: 'Sheep', class: 'Ram', basis: 'head', price: 50 },   // far too low
  ] });
  assert.strictEqual(res.body.result.flagged, 2);
  const lamb = await pendingFor(admin, 'Sheep', 'Lamb');
  assert.strictEqual(lamb.price, 14350);
  assert.match(lamb.flag_reason, /more than 25%/);
  assert.match((await pendingFor(admin, 'Sheep', 'Ram')).flag_reason, /outside the normal range/);
  const count = await db.query(`SELECT COUNT(*)::int AS n FROM price_proposal WHERE status = 'pending' AND species = 'Sheep' AND class = 'Lamb'`);
  assert.strictEqual(count.rows[0].n, 1);
});

test('typical weights can be changed and are used for per-kg quotes', async () => {
  await clean('Goat', ['Buck']);
  const admin = await makeAdmin();
  let w = (await request(app).get('/api/v1/admin/class-weights').set(auth(admin))).body.weights;
  assert.strictEqual(w.length, 13);
  assert.strictEqual(w.find((x) => x.species === 'Goat' && x.class === 'Buck').weight_kg, 55);

  assert.strictEqual((await request(app).put('/api/v1/admin/class-weights').set(auth(admin)).send({ weights: [{ species: 'Goat', class: 'Buck', weight_kg: -3 }] })).status, 400);
  const put = await request(app).put('/api/v1/admin/class-weights').set(auth(admin)).send({ weights: [{ species: 'Goat', class: 'Buck', weight_kg: 60 }] });
  assert.strictEqual(put.body.weights.find((x) => x.species === 'Goat' && x.class === 'Buck').weight_kg, 60);

  await submit({ items: [{ species: 'Goat', class: 'Buck', basis: 'kg', price: 40 }] });
  assert.strictEqual((await pendingFor(admin, 'Goat', 'Buck')).price, 2400);
  await clean('Goat', ['Buck']);
});

test('with auto-approve on, clean quotes go live and flagged ones still wait', async () => {
  await clean('Goat', ['Buck', 'Wether']);
  const admin = await makeAdmin();
  process.env.PRICE_AGENT_AUTO_APPROVE = 'true';
  try {
    const res = await submit({ source: 'auto test', items: [
      { species: 'Goat', class: 'Buck', basis: 'head', price: 1200 },
      { species: 'Goat', class: 'Wether', basis: 'head', price: 99999 },
    ] });
    assert.strictEqual(res.body.result.applied, 1);
    assert.strictEqual(res.body.result.pending, 1);
  } finally { delete process.env.PRICE_AGENT_AUTO_APPROVE; }
  const prices = (await request(app).get('/api/v1/admin/market-prices').set(auth(admin))).body.prices;
  assert.strictEqual(prices.find((p) => p.species === 'Goat' && p.class === 'Buck').price, 1200);
  assert.ok(!prices.find((p) => p.species === 'Goat' && p.class === 'Wether'));
  await clean('Goat', ['Buck', 'Wether']);
});
