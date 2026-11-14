const { test } = require('node:test');
const assert = require('node:assert');
const { request, app, registerFarmer } = require('./helpers');

test('the weekly farm round is built from the herd and is not added twice', async () => {
  const farmer = await registerFarmer();
  const auth = { Authorization: `Bearer ${farmer.token}` };
  await request(app).post('/api/v1/animals').set(auth).send({ tag_number: 'W-COW', species: 'Cattle', class: 'Cow', head_count: 3 });
  await request(app).post('/api/v1/animals').set(auth).send({ tag_number: 'W-CALF', species: 'Cattle', class: 'Calf' });

  const first = await request(app).post('/api/v1/tasks/weekly-round').set(auth).send({});
  assert.strictEqual(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.added.some((t) => t.startsWith('Walk the herd')));
  assert.ok(first.body.added.some((t) => t.startsWith('Check females')));
  assert.ok(first.body.added.some((t) => t.startsWith('Check young animals')));
  assert.ok(first.body.added.some((t) => t.startsWith('Vaccinations due for 4 animals')));

  const second = await request(app).post('/api/v1/tasks/weekly-round').set(auth).send({});
  assert.deepStrictEqual(second.body.added, []);

  const list = await request(app).get('/api/v1/tasks?done=false').set(auth);
  const titles = list.body.tasks.map((t) => t.title);
  assert.strictEqual(titles.filter((t) => t.startsWith('Walk the herd')).length, 1);
});

test('a farm with no animals still gets the general round, without herd-specific items', async () => {
  const farmer = await registerFarmer();
  const res = await request(app).post('/api/v1/tasks/weekly-round').set(`Authorization`, `Bearer ${farmer.token}`).send({});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.added.length, 2);
});
