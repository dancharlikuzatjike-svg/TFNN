const { test } = require('node:test');
const assert = require('node:assert');
const { request, app, registerFarmer } = require('./helpers');

test("a farmer cannot see another farmer's animals", async () => {
  const farmerA = await registerFarmer();
  const farmerB = await registerFarmer();

  const createRes = await request(app)
    .post('/api/v1/animals')
    .set('Authorization', `Bearer ${farmerA.token}`)
    .send({ tag_number: 'TEST-001', species: 'Cattle' });
  assert.strictEqual(createRes.status, 201);
  const animalId = createRes.body.animal.animal_id;

  const listAsB = await request(app)
    .get('/api/v1/animals')
    .set('Authorization', `Bearer ${farmerB.token}`);
  const idsB = listAsB.body.animals.map(a => a.animal_id);
  assert.ok(!idsB.includes(animalId), "Farmer B should not see Farmer A's animal in their list");

  const detailAsB = await request(app)
    .get(`/api/v1/animals/${animalId}`)
    .set('Authorization', `Bearer ${farmerB.token}`);
  assert.strictEqual(detailAsB.status, 404, 'Farmer B should get 404, not the animal, on direct lookup');
});

test('a farmer cannot see another farmer\'s sales or expenses', async () => {
  const farmerA = await registerFarmer();
  const farmerB = await registerFarmer();

  await request(app)
    .post('/api/v1/expenses')
    .set('Authorization', `Bearer ${farmerA.token}`)
    .send({ amount: 500, category: 'Feed', description: 'A private expense' });

  const expensesAsB = await request(app)
    .get('/api/v1/expenses')
    .set('Authorization', `Bearer ${farmerB.token}`);
  const leaked = expensesAsB.body.expenses.some(e => e.description === 'A private expense');
  assert.strictEqual(leaked, false, "Farmer B should never see Farmer A's expense");
});

test('an unauthenticated request is rejected', async () => {
  const res = await request(app).get('/api/v1/animals');
  assert.strictEqual(res.status, 401);
});

test('a non-admin cannot access admin routes', async () => {
  const farmer = await registerFarmer();
  const res = await request(app)
    .get('/api/v1/admin/users')
    .set('Authorization', `Bearer ${farmer.token}`);
  assert.strictEqual(res.status, 403);
});
