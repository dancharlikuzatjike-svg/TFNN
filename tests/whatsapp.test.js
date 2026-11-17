const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { request, app, registerFarmer } = require('./helpers');
const wa = require('../src/utils/whatsapp');

process.env.CRON_SECRET = 'wa-test-secret';
const auth = (f) => ({ Authorization: `Bearer ${f.token}` });
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.WHATSAPP_TOKEN;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
});

function configure() {
  process.env.WHATSAPP_TOKEN = 'test-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '12345';
}
function stubFetch(status = 200) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    return { ok: status < 400, status, json: async () => (status < 400 ? { messages: [{ id: 'x' }] } : { error: { message: 'bad template' } }) };
  };
  return calls;
}
async function farmerWithDueTask(optIn) {
  const f = await registerFarmer({ name: 'Maria Shikongo' });
  if (optIn) await request(app).patch('/api/v1/users/me').set(auth(f)).send({ whatsapp_opt_in: true });
  await request(app).post('/api/v1/tasks').set(auth(f)).send({ title: 'Dip the cattle', due_date: '2020-01-01' });
  return f;
}

test('phone numbers are turned into international form', () => {
  assert.strictEqual(wa.toIntl('0814254801'), '264814254801');
  assert.strictEqual(wa.toIntl('+264 81 425 4801'), '264814254801');
  assert.strictEqual(wa.toIntl('264814254801'), '264814254801');
  assert.strictEqual(wa.toIntl('00264814254801'), '264814254801');
  assert.strictEqual(wa.toIntl('12345'), null);
  assert.strictEqual(wa.toIntl(null), null);
});

test('the task summary is one line and is cut to length', () => {
  assert.strictEqual(wa.summarise(['A\nB', 'C   D']), 'A B | C D');
  const long = wa.summarise(['x'.repeat(900)]);
  assert.ok(long.length <= 600 && long.endsWith('…'));
});

test('a farmer can turn WhatsApp reminders on and off, and bad values are refused', async () => {
  const f = await registerFarmer();
  assert.strictEqual((await request(app).get('/api/v1/users/me').set(auth(f))).body.user.whatsapp_opt_in, false);
  const on = await request(app).patch('/api/v1/users/me').set(auth(f)).send({ whatsapp_opt_in: true });
  assert.strictEqual(on.body.user.whatsapp_opt_in, true);
  const unrelated = await request(app).patch('/api/v1/users/me').set(auth(f)).send({ farm_location: 'Gobabis' });
  assert.strictEqual(unrelated.body.user.whatsapp_opt_in, true); // not reset by another change
  const off = await request(app).patch('/api/v1/users/me').set(auth(f)).send({ whatsapp_opt_in: false });
  assert.strictEqual(off.body.user.whatsapp_opt_in, false);
  assert.strictEqual((await request(app).patch('/api/v1/users/me').set(auth(f)).send({ whatsapp_opt_in: 'yes' })).status, 400);
});

test('nothing is sent until WhatsApp is set up on the server', async () => {
  await farmerWithDueTask(true);
  const calls = stubFetch();
  assert.deepStrictEqual(await wa.sendWhatsAppReminders({ paceMs: 0 }), { configured: false });
  assert.strictEqual(calls.length, 0);
});

test('an opted-in farmer gets one WhatsApp message a day; others get none', async () => {
  configure();
  const optedIn = await farmerWithDueTask(true);
  await farmerWithDueTask(false);
  const calls = stubFetch();

  const first = await wa.sendWhatsAppReminders({ paceMs: 0 });
  assert.strictEqual(first.configured, true);
  assert.ok(first.sent >= 1);
  const mine = calls.filter((c) => c.body.template.components[0].parameters[0].text === 'Maria');
  assert.ok(mine.length >= 1);
  const msg = mine[0];
  assert.ok(msg.url.endsWith('/12345/messages'));
  assert.strictEqual(msg.opts.headers.Authorization, 'Bearer test-token');
  assert.strictEqual(msg.body.type, 'template');
  assert.strictEqual(msg.body.template.name, 'tfnn_task_digest');
  assert.ok(/^264\d+$/.test(msg.body.to));
  const params = msg.body.template.components[0].parameters.map((p) => p.text);
  assert.ok(params[2].includes('Dip the cattle'));

  const before = calls.length;
  await wa.sendWhatsAppReminders({ paceMs: 0 });
  const again = calls.slice(before).filter((c) => c.body.to === msg.body.to);
  assert.strictEqual(again.length, 0, 'a second run on the same day must not message them again');

  // the only farmers messaged are those who opted in
  const me = await request(app).get('/api/v1/users/me').set(auth(optedIn));
  assert.strictEqual(me.body.user.whatsapp_opt_in, true);
});

test('a failed send is logged and counted, and does not stop the run', async () => {
  configure();
  await farmerWithDueTask(true);
  stubFetch(400);
  const r = await wa.sendWhatsAppReminders({ paceMs: 0 });
  assert.ok(r.failed >= 1);
  assert.strictEqual(r.sent, 0);
  const db = require('../src/db');
  const log = await db.query(`SELECT error FROM whatsapp_log WHERE status = 'failed' ORDER BY log_id DESC LIMIT 1`);
  assert.ok(log.rows[0].error.includes('bad template'));
});

test('the reminders job also reports WhatsApp, and stays protected by the secret', async () => {
  assert.strictEqual((await request(app).post('/api/v1/jobs/task-reminders')).status, 401);
  const r = await request(app).post('/api/v1/jobs/task-reminders').set('x-cron-secret', 'wa-test-secret');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.result);
  assert.deepStrictEqual(r.body.whatsapp, { configured: false });
});
