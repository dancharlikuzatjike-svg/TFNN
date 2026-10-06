const { test } = require('node:test');
const assert = require('node:assert');
const { request, app, registerFarmer } = require('./helpers');
const db = require('../src/db');

const auth = (t) => ({ Authorization: `Bearer ${t}` });
async function adminToken() {
  const f = await registerFarmer();
  await db.query(`UPDATE users SET role = 'admin' WHERE user_id = $1`, [f.user.user_id]);
  const login = await request(app).post('/api/v1/auth/login').send({ phone: f.phone, password: f.password });
  assert.strictEqual(login.status, 200, JSON.stringify(login.body));
  return login.body.token;
}

test('a new farmer starts on a free trial as a small farmer with the right fees', async () => {
  const f = await registerFarmer();
  const r = await request(app).get('/api/v1/billing/me').set(auth(f.token));
  assert.strictEqual(r.status, 200);
  const m = r.body.membership;
  assert.strictEqual(m.tier, 'small_farmer');
  assert.strictEqual(m.status, 'trial');
  assert.strictEqual(m.monthly_fee, 300);
  assert.strictEqual(m.registration_fee, 50);
  assert.strictEqual(m.amount_due_now, 350);
  assert.strictEqual(r.body.pricing.marketplace_fee_percent, 4);
});

test('farm size decides the tier: 100+ animals is a big farm, 300+ pays the top rate', async () => {
  const f = await registerFarmer();
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push(`(${f.user.user_id}, 'T${i}', 'Cattle')`);
  await db.query(`INSERT INTO animal (owner_id, tag_number, species) VALUES ${rows.join(',')}`);
  let r = await request(app).get('/api/v1/billing/me').set(auth(f.token));
  assert.strictEqual(r.body.membership.tier, 'big_farmer');
  assert.strictEqual(r.body.membership.monthly_fee, 500);
  assert.strictEqual(r.body.membership.registration_fee, 100);
  const more = [];
  for (let i = 100; i < 300; i++) more.push(`(${f.user.user_id}, 'T${i}', 'Cattle')`);
  await db.query(`INSERT INTO animal (owner_id, tag_number, species) VALUES ${more.join(',')}`);
  r = await request(app).get('/api/v1/billing/me').set(auth(f.token));
  assert.strictEqual(r.body.membership.tier, 'huge_farmer');
  assert.strictEqual(r.body.membership.monthly_fee, 650);
});

test('admin records a registration fee and membership months; totals and claims update', async () => {
  const admin = await adminToken();
  const f = await registerFarmer();
  await request(app).post('/api/v1/billing/claim').set(auth(f.token)).expect(200);
  let b = await request(app).get('/api/v1/admin/billing').set(auth(admin));
  assert.ok(b.body.claims.some((c) => c.user_id === f.user.user_id));

  const reg = await request(app).post('/api/v1/admin/payments').set(auth(admin)).send({ user_id: f.user.user_id, kind: 'registration' });
  assert.strictEqual(reg.status, 201);
  const pay = await request(app).post('/api/v1/admin/payments').set(auth(admin)).send({ phone: f.phone, kind: 'membership', months: 3 });
  assert.strictEqual(pay.status, 201, JSON.stringify(pay.body));
  assert.strictEqual(pay.body.membership.status, 'active');
  assert.strictEqual(pay.body.membership.registration_paid, true);
  assert.strictEqual(pay.body.membership.amount_due_now, 0);

  b = await request(app).get('/api/v1/admin/billing').set(auth(admin));
  assert.ok(!b.body.claims.some((c) => c.user_id === f.user.user_id), 'claim is cleared once paid');
  assert.ok(b.body.totals.this_month >= 50 + 900);

  // validation and permissions
  assert.strictEqual((await request(app).post('/api/v1/admin/payments').set(auth(admin)).send({ user_id: f.user.user_id, kind: 'membership', months: 99 })).status, 400);
  assert.strictEqual((await request(app).post('/api/v1/admin/payments').set(auth(admin)).send({ phone: '0000000000', kind: 'membership' })).status, 404);
  assert.strictEqual((await request(app).post('/api/v1/admin/payments').set(auth(f.token)).send({ user_id: f.user.user_id, kind: 'membership' })).status, 403);
});

test('an expired membership can read but not change records, once billing is switched on', async () => {
  const f = await registerFarmer();
  await db.query(`UPDATE users SET trial_ends = CURRENT_DATE - 1 WHERE user_id = $1`, [f.user.user_id]);
  const body = { tag_number: 'EXP-1', species: 'Cattle' };

  // not enforced yet: still works
  delete process.env.BILLING_ENFORCED;
  assert.strictEqual((await request(app).post('/api/v1/animals').set(auth(f.token)).send(body)).status, 201);

  process.env.BILLING_ENFORCED = 'true';
  try {
    const blocked = await request(app).post('/api/v1/animals').set(auth(f.token)).send({ tag_number: 'EXP-2', species: 'Cattle' });
    assert.strictEqual(blocked.status, 402);
    assert.strictEqual(blocked.body.code, 'membership_required');
    assert.strictEqual((await request(app).get('/api/v1/animals').set(auth(f.token))).status, 200, 'reading still works');
    assert.strictEqual((await request(app).get('/api/v1/billing/me').set(auth(f.token))).status, 200);
    assert.strictEqual((await request(app).post('/api/v1/billing/claim').set(auth(f.token))).status, 200, 'can still say they paid');

    await db.query(`UPDATE users SET paid_until = CURRENT_DATE + 30 WHERE user_id = $1`, [f.user.user_id]);
    assert.strictEqual((await request(app).post('/api/v1/animals').set(auth(f.token)).send({ tag_number: 'EXP-3', species: 'Cattle' })).status, 201);
  } finally {
    delete process.env.BILLING_ENFORCED;
  }
});
