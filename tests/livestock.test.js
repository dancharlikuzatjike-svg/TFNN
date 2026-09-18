const { test } = require('node:test');
const assert = require('node:assert');
const { request, app, registerFarmer, crypto } = require('./helpers');

test('a farmer can create an animal and log an event against it', async () => {
  const farmer = await registerFarmer();

  const createRes = await request(app)
    .post('/api/v1/animals')
    .set('Authorization', `Bearer ${farmer.token}`)
    .send({ tag_number: 'LT-100', species: 'Sheep', breed: 'Damara' });
  assert.strictEqual(createRes.status, 201);
  const animalId = createRes.body.animal.animal_id;

  const eventRes = await request(app)
    .post('/api/v1/events')
    .set('Authorization', `Bearer ${farmer.token}`)
    .send({ animal_id: animalId, event_date: '2026-01-01', event_type: 'Vaccinated' });
  assert.strictEqual(eventRes.status, 201);

  const historyRes = await request(app)
    .get(`/api/v1/animals/${animalId}/events`)
    .set('Authorization', `Bearer ${farmer.token}`);
  assert.strictEqual(historyRes.body.events.length, 1);
  assert.strictEqual(historyRes.body.events[0].event_type, 'Vaccinated');
});

test('a duplicate client_id does not create a second animal', async () => {
  const farmer = await registerFarmer();
  const client_id = crypto.randomUUID();
  const body = { tag_number: 'LT-DUP', species: 'Goat', client_id };

  const first = await request(app).post('/api/v1/animals').set('Authorization', `Bearer ${farmer.token}`).send(body);
  const second = await request(app).post('/api/v1/animals').set('Authorization', `Bearer ${farmer.token}`).send(body);

  assert.strictEqual(first.status, 201);
  assert.strictEqual(second.status, 200);
  assert.strictEqual(first.body.animal.animal_id, second.body.animal.animal_id);
});

test('correcting an event supersedes the old one instead of overwriting it', async () => {
  const farmer = await registerFarmer();
  const animal = await request(app)
    .post('/api/v1/animals')
    .set('Authorization', `Bearer ${farmer.token}`)
    .send({ tag_number: 'LT-200', species: 'Cattle' });
  const animalId = animal.body.animal.animal_id;

  const original = await request(app)
    .post('/api/v1/events')
    .set('Authorization', `Bearer ${farmer.token}`)
    .send({ animal_id: animalId, event_date: '2026-01-01', event_type: 'Vaccinated', notes: 'wrong vaccine' });
  const originalId = original.body.event.event_id;

  const corrected = await request(app)
    .patch(`/api/v1/events/${originalId}`)
    .set('Authorization', `Bearer ${farmer.token}`)
    .send({ notes: 'correct vaccine' });
  assert.strictEqual(corrected.status, 200);
  assert.notStrictEqual(corrected.body.event.event_id, originalId, 'a correction should create a new row, not mutate the old one');

  const history = await request(app)
    .get(`/api/v1/events/${originalId}/history`)
    .set('Authorization', `Bearer ${farmer.token}`);
  assert.strictEqual(history.body.history.length, 2, 'both the original and corrected event should be visible in history');
});
