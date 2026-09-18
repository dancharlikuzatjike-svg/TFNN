const { test } = require('node:test');
const assert = require('node:assert');
const { request, app, registerFarmer } = require('./helpers');

async function makeActiveAnimal(farmer, tag) {
  const res = await request(app)
    .post('/api/v1/animals')
    .set('Authorization', `Bearer ${farmer.token}`)
    .send({ tag_number: tag, species: 'Cattle' });
  return res.body.animal;
}

test('recording a sale marks the animal Sold and updates valuation', async () => {
  const farmer = await registerFarmer();
  const animal = await makeActiveAnimal(farmer, 'FIN-001');

  const saleRes = await request(app)
    .post('/api/v1/sales')
    .set('Authorization', `Bearer ${farmer.token}`)
    .send({ animal_id: animal.animal_id, buyer_name: 'Test Buyer', price: 5000 });
  assert.strictEqual(saleRes.status, 201);

  const animalAfter = await request(app)
    .get(`/api/v1/animals/${animal.animal_id}`)
    .set('Authorization', `Bearer ${farmer.token}`);
  assert.strictEqual(animalAfter.body.animal.status, 'Sold');

  const valuation = await request(app)
    .get('/api/v1/valuation')
    .set('Authorization', `Bearer ${farmer.token}`);
  assert.ok(valuation.body.sales.total_sales_income >= 5000);
});

test('an expense is recorded and reflected in valuation', async () => {
  const farmer = await registerFarmer();
  const expenseRes = await request(app)
    .post('/api/v1/expenses')
    .set('Authorization', `Bearer ${farmer.token}`)
    .send({ amount: 300, category: 'Feed' });
  assert.strictEqual(expenseRes.status, 201);

  const valuation = await request(app)
    .get('/api/v1/valuation')
    .set('Authorization', `Bearer ${farmer.token}`);
  assert.ok(valuation.body.expenses.total_expenses >= 300);
});

test('cannot sell an animal that is already Sold', async () => {
  const farmer = await registerFarmer();
  const animal = await makeActiveAnimal(farmer, 'FIN-002');
  await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${farmer.token}`).send({ animal_id: animal.animal_id, buyer_name: 'A', price: 100 });
  const second = await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${farmer.token}`).send({ animal_id: animal.animal_id, buyer_name: 'B', price: 200 });
  assert.strictEqual(second.status, 400);
});

test('cancelling a sale returns the animal to Active', async () => {
  const farmer = await registerFarmer();
  const animal = await makeActiveAnimal(farmer, 'FIN-003');
  const sale = await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${farmer.token}`).send({ animal_id: animal.animal_id, buyer_name: 'C', price: 100 });

  const cancelRes = await request(app)
    .delete(`/api/v1/sales/${sale.body.sale.sale_id}`)
    .set('Authorization', `Bearer ${farmer.token}`);
  assert.strictEqual(cancelRes.status, 204);

  const animalAfter = await request(app)
    .get(`/api/v1/animals/${animal.animal_id}`)
    .set('Authorization', `Bearer ${farmer.token}`);
  assert.strictEqual(animalAfter.body.animal.status, 'Active');
});
