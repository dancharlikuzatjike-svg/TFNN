const { test } = require('node:test');
const assert = require('node:assert');
const { request, app, registerFarmer, randomPhone } = require('./helpers');
const db = require('../src/db');

const auth = (u) => ({ Authorization: 'Bearer ' + u.token });
const login = (phone, password) => request(app).post('/api/v1/auth/login').send({ phone, password });

async function makeAdmin() {
  const u = await registerFarmer();
  await db.query(`UPDATE users SET role = 'admin' WHERE phone = $1`, [u.phone]);
  const res = await login(u.phone, u.password);
  return { ...u, token: res.body.token };
}

test('admin reset code lets a farmer set a new password, once', async () => {
  const admin = await makeAdmin();
  const farmer = await registerFarmer();

  const made = await request(app).post(`/api/v1/admin/users/${farmer.user.user_id}/reset-code`).set(auth(admin));
  assert.strictEqual(made.status, 200);
  assert.match(made.body.code, /^\d{6}$/);

  // The code itself is never stored
  const stored = await db.query('SELECT code_hash FROM password_reset WHERE user_id = $1', [farmer.user.user_id]);
  assert.ok(!stored.rows.some((r) => r.code_hash.includes(made.body.code)));

  const short = await request(app).post('/api/v1/auth/reset').send({ phone: farmer.phone, code: made.body.code, new_password: 'short' });
  assert.strictEqual(short.status, 400);

  const done = await request(app).post('/api/v1/auth/reset').send({ phone: farmer.phone, code: made.body.code, new_password: 'brandnewpass1' });
  assert.strictEqual(done.status, 200);

  assert.strictEqual((await login(farmer.phone, farmer.password)).status, 401);
  assert.strictEqual((await login(farmer.phone, 'brandnewpass1')).status, 200);

  const again = await request(app).post('/api/v1/auth/reset').send({ phone: farmer.phone, code: made.body.code, new_password: 'anotherpass22' });
  assert.strictEqual(again.status, 400);
});

test('a farmer cannot make reset codes', async () => {
  const a = await registerFarmer();
  const b = await registerFarmer();
  const res = await request(app).post(`/api/v1/admin/users/${b.user.user_id}/reset-code`).set(auth(a));
  assert.strictEqual(res.status, 403);
});

test('a reset code dies after five wrong tries, and a new code cancels the old one', async () => {
  const admin = await makeAdmin();
  const farmer = await registerFarmer();
  const url = `/api/v1/admin/users/${farmer.user.user_id}/reset-code`;

  const first = (await request(app).post(url).set(auth(admin))).body.code;
  const wrong = first === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    const r = await request(app).post('/api/v1/auth/reset').send({ phone: farmer.phone, code: wrong, new_password: 'brandnewpass1' });
    assert.strictEqual(r.status, 400);
  }
  const dead = await request(app).post('/api/v1/auth/reset').send({ phone: farmer.phone, code: first, new_password: 'brandnewpass1' });
  assert.strictEqual(dead.status, 400);

  const second = (await request(app).post(url).set(auth(admin))).body.code;
  const third = (await request(app).post(url).set(auth(admin))).body.code;
  if (second !== third) {
    const old = await request(app).post('/api/v1/auth/reset').send({ phone: farmer.phone, code: second, new_password: 'brandnewpass1' });
    assert.strictEqual(old.status, 400);
  }
  const ok = await request(app).post('/api/v1/auth/reset').send({ phone: farmer.phone, code: third, new_password: 'brandnewpass1' });
  assert.strictEqual(ok.status, 200);
});

test('an expired reset code is refused', async () => {
  const admin = await makeAdmin();
  const farmer = await registerFarmer();
  const code = (await request(app).post(`/api/v1/admin/users/${farmer.user.user_id}/reset-code`).set(auth(admin))).body.code;
  await db.query(`UPDATE password_reset SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [farmer.user.user_id]);
  const res = await request(app).post('/api/v1/auth/reset').send({ phone: farmer.phone, code, new_password: 'brandnewpass1' });
  assert.strictEqual(res.status, 400);
});

test('changing the password signs out older sessions', async () => {
  const admin = await makeAdmin();
  const farmer = await registerFarmer();
  const before = await request(app).post('/api/v1/auth/refresh').send({ refresh_token: farmer.refresh_token });
  assert.strictEqual(before.status, 200);

  await new Promise((r) => setTimeout(r, 1100)); // sign-in times are kept to the second
  const code = (await request(app).post(`/api/v1/admin/users/${farmer.user.user_id}/reset-code`).set(auth(admin))).body.code;
  await request(app).post('/api/v1/auth/reset').send({ phone: farmer.phone, code, new_password: 'brandnewpass1' });

  const after = await request(app).post('/api/v1/auth/refresh').send({ refresh_token: farmer.refresh_token });
  assert.strictEqual(after.status, 401);

  const fresh = await login(farmer.phone, 'brandnewpass1');
  const stillGood = await request(app).post('/api/v1/auth/refresh').send({ refresh_token: fresh.body.refresh_token });
  assert.strictEqual(stillGood.status, 200);
});

test('forgot gives the same answer for a real and an unknown number', async () => {
  const farmer = await registerFarmer();
  const real = await request(app).post('/api/v1/auth/forgot').send({ phone: farmer.phone });
  const fake = await request(app).post('/api/v1/auth/forgot').send({ phone: randomPhone() });
  assert.strictEqual(real.status, 200);
  assert.deepStrictEqual(real.body, fake.body);

  // Only three requests an hour per number
  await request(app).post('/api/v1/auth/forgot').send({ phone: farmer.phone });
  await request(app).post('/api/v1/auth/forgot').send({ phone: farmer.phone });
  const fourth = await request(app).post('/api/v1/auth/forgot').send({ phone: farmer.phone });
  assert.strictEqual(fourth.status, 429);
});

test('ten wrong passwords lock sign-in for that number, and a reset unlocks it', async () => {
  const admin = await makeAdmin();
  const farmer = await registerFarmer();
  for (let i = 0; i < 10; i++) assert.strictEqual((await login(farmer.phone, 'wrongpass' + i)).status, 401);

  const locked = await login(farmer.phone, farmer.password);
  assert.strictEqual(locked.status, 429);
  assert.match(locked.body.error, /Too many/);

  // Someone else is not affected
  const other = await registerFarmer();
  assert.strictEqual((await login(other.phone, other.password)).status, 200);

  const code = (await request(app).post(`/api/v1/admin/users/${farmer.user.user_id}/reset-code`).set(auth(admin))).body.code;
  await request(app).post('/api/v1/auth/reset').send({ phone: farmer.phone, code, new_password: 'brandnewpass1' });
  assert.strictEqual((await login(farmer.phone, 'brandnewpass1')).status, 200);
});
