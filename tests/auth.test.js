const { test } = require('node:test');
const assert = require('node:assert');
const { request, app, registerFarmer, randomPhone } = require('./helpers');

test('registering as farmer returns a usable token immediately', async () => {
  const user = await registerFarmer();
  assert.ok(user.token, 'expected an access token on farmer registration');
  assert.strictEqual(user.user.role, 'farmer');
});

test('registering with role=admin is rejected', async () => {
  const res = await request(app).post('/api/v1/auth/register').send({
    name: 'Sneaky',
    phone: randomPhone(),
    password: 'testpass123',
    role: 'admin',
  });
  assert.strictEqual(res.status, 400);
});

test('registering as supplier does NOT return a token (pending approval)', async () => {
  const res = await request(app).post('/api/v1/auth/register').send({
    name: 'New Supplier',
    phone: randomPhone(),
    password: 'testpass123',
    role: 'supplier',
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.token, undefined);
});

test('a pending supplier cannot log in until approved', async () => {
  const phone = randomPhone();
  await request(app).post('/api/v1/auth/register').send({
    name: 'Pending Vet', phone, password: 'testpass123', role: 'vet',
  });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ phone, password: 'testpass123' });
  assert.strictEqual(loginRes.status, 403);
});

test('login with wrong password is rejected with a generic error', async () => {
  const farmer = await registerFarmer();
  const res = await request(app).post('/api/v1/auth/login').send({
    phone: farmer.phone,
    password: 'wrongpassword',
  });
  assert.strictEqual(res.status, 401);
});

test('login with correct credentials returns a token', async () => {
  const farmer = await registerFarmer();
  const res = await request(app).post('/api/v1/auth/login').send({
    phone: farmer.phone,
    password: farmer.password,
  });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.token);
});
