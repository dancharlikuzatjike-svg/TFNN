// Every email path, with Resend mocked: nothing here sends real mail.
process.env.RESEND_API_KEY = 're_test_key';
process.env.RESEND_FROM_ADDRESS = 'TFNN <hello@test.example>';
process.env.CRON_SECRET = 'cron-test-secret';
process.env.EMAIL_PACE_MS = '0';

const test = require('node:test');
const assert = require('node:assert');
const { request, app, registerFarmer, crypto } = require('./helpers');
const db = require('../src/db');

// ---- Resend mock ----
const realFetch = global.fetch;
let sent = [];
let failWith = null; // set to a message to make Resend answer 403
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.resend.com')) {
    if (failWith) return { ok: false, status: 403, json: async () => ({ message: failWith }) };
    sent.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ id: 'mock_' + sent.length }) };
  }
  return realFetch(url, opts);
};
const emailsTo = (addr) => sent.filter((m) => m.to === addr);
async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
}
const tag = crypto.randomBytes(4).toString('hex');
const addr = (n) => `${n}-${tag}@test.example`;
const createdIds = [];
const track = (u) => { if (u && u.user) createdIds.push(u.user.user_id); return u; };
const auth = (t) => ({ Authorization: 'Bearer ' + t });

async function farmerWithEmail(name, email, extra = {}) {
  const res = await request(app).post('/api/v1/auth/register').send({
    name, phone: '08' + Math.floor(10000000 + Math.random() * 89999999), password: 'testpass123', role: 'farmer', email, ...extra,
  });
  return track({ ...res.body, status: res.status });
}
async function makeAdmin() {
  const f = await registerFarmer({ name: 'Admin ' + tag });
  track(f);
  await db.query(`UPDATE users SET role = 'admin' WHERE user_id = $1`, [f.user.user_id]);
  const login = await request(app).post('/api/v1/auth/login').send({ phone: f.phone, password: f.password });
  return { token: login.body.token, id: f.user.user_id };
}
async function setProfile(token, body) {
  return request(app).patch('/api/v1/users/me').set(auth(token)).send(body);
}

test.after(async () => {
  global.fetch = realFetch;
  if (createdIds.length) {
    await db.query('DELETE FROM task WHERE farmer_id = ANY($1)', [createdIds]);
    await db.query('DELETE FROM notification WHERE user_id = ANY($1)', [createdIds]);
    await db.query('DELETE FROM email_log WHERE user_id = ANY($1)', [createdIds]);
    await db.query('DELETE FROM district_alert WHERE posted_by = ANY($1)', [createdIds]);
    await db.query('DELETE FROM users WHERE user_id = ANY($1)', [createdIds]);
  }
  await db.end?.();
});

test('sign-up with an email sends a branded welcome email and an in-app welcome', async () => {
  const a = await farmerWithEmail('Welcome Farmer', addr('welcome'));
  assert.strictEqual(a.status, 201);
  assert.ok(await waitFor(() => emailsTo(addr('welcome')).length === 1), 'welcome email was not sent');
  const m = emailsTo(addr('welcome'))[0];
  assert.match(m.subject, /Welcome to TFNN/);
  assert.strictEqual(m.from, 'TFNN <hello@test.example>');
  assert.ok(m.html.includes('TFNN') && m.text.includes('Welcome'));
  const n = await request(app).get('/api/v1/notifications').set(auth(a.token));
  assert.ok(JSON.stringify(n.body).includes('Welcome to TFNN'));
});

test('sign-up without an email still works and sends nothing', async () => {
  const before = sent.length;
  const a = await farmerWithEmail('No Email', undefined);
  assert.strictEqual(a.status, 201);
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(sent.length, before);
});

test('an invalid email at sign-up is rejected', async () => {
  const res = await request(app).post('/api/v1/auth/register').send({ name: 'Bad', phone: '0811111111', password: 'testpass123', role: 'farmer', email: 'not-an-email' });
  assert.strictEqual(res.status, 400);
});

test('adding an email in Settings sends a confirmation; clearing it removes the address', async () => {
  const a = await farmerWithEmail('Settings Farmer', undefined);
  const r = await setProfile(a.token, { email: addr('settings') });
  assert.strictEqual(r.status, 200);
  assert.ok(await waitFor(() => emailsTo(addr('settings')).some((m) => /Email notifications are on/.test(m.subject))));
  const cleared = await setProfile(a.token, { email: '' });
  assert.strictEqual(cleared.body.user.email, null);
  assert.strictEqual((await setProfile(a.token, { email_opt_out: 'yes' })).status, 400);
});

test('district alert emails farmers in that district only, and respects opt-out', async () => {
  const admin = await makeAdmin();
  const inD = await farmerWithEmail('In District', addr('indistrict'));
  const optedOut = await farmerWithEmail('Opted Out', addr('optedout'));
  const elsewhere = await farmerWithEmail('Elsewhere', addr('elsewhere'));
  await setProfile(inD.token, { district: 'Zambezi' });
  await setProfile(optedOut.token, { district: 'Zambezi', email_opt_out: true });
  await setProfile(elsewhere.token, { district: 'Khomas' });
  sent.length = 0;

  const res = await request(app).post('/api/v1/alerts').set(auth(admin.token))
    .send({ district: 'Zambezi', title: 'Anthrax reported', description: 'Vaccinate cattle now.', severity: 'Emergency' });
  assert.strictEqual(res.status, 201);

  assert.ok(await waitFor(() => emailsTo(addr('indistrict')).length === 1), 'district farmer was not emailed');
  const m = emailsTo(addr('indistrict'))[0];
  assert.match(m.subject, /Emergency alert - Zambezi: Anthrax reported/);
  assert.ok(m.text.includes('Vaccinate cattle now.'));
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(emailsTo(addr('optedout')).length, 0, 'opted-out farmer must not be emailed');
  assert.strictEqual(emailsTo(addr('elsewhere')).length, 0, 'other district must not be emailed');
  // opted-out farmer still gets the in-app notification
  const n = await request(app).get('/api/v1/notifications').set(auth(optedOut.token));
  assert.ok(JSON.stringify(n.body).includes('Anthrax reported'));
});

test('only admins can broadcast; input is validated; message is HTML-escaped', async () => {
  const admin = await makeAdmin();
  const f = await farmerWithEmail('Broadcast Farmer', addr('bcast'));
  await setProfile(f.token, { district: 'Omaheke' });

  assert.strictEqual((await request(app).post('/api/v1/admin/broadcast').set(auth(f.token)).send({ subject: 'x', message: 'y' })).status, 403);
  assert.strictEqual((await request(app).post('/api/v1/admin/broadcast').set(auth(admin.token)).send({ subject: '' , message: 'y' })).status, 400);
  assert.strictEqual((await request(app).post('/api/v1/admin/broadcast').set(auth(admin.token)).send({ subject: 'x', message: 'y', district: 'Atlantis' })).status, 400);

  sent.length = 0;
  const res = await request(app).post('/api/v1/admin/broadcast').set(auth(admin.token))
    .send({ subject: 'Market day Friday', message: 'Bring <script>alert(1)</script> animals & tags.', district: 'Omaheke' });
  assert.strictEqual(res.status, 202);
  assert.ok(res.body.recipients >= 1 && res.body.with_email >= 1);
  assert.ok(await waitFor(() => emailsTo(addr('bcast')).length === 1));
  const m = emailsTo(addr('bcast'))[0];
  assert.ok(!m.html.includes('<script>alert'), 'raw script tag leaked into HTML');
  assert.ok(m.html.includes('&lt;script&gt;'));
});

test('admin test-email: needs an address, delivers, and reports Resend errors clearly', async () => {
  const admin = await makeAdmin();
  assert.strictEqual((await request(app).post('/api/v1/admin/test-email').set(auth(admin.token)).send({})).status, 400);
  sent.length = 0;
  const ok = await request(app).post('/api/v1/admin/test-email').set(auth(admin.token)).send({ to: addr('probe') });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(emailsTo(addr('probe')).length, 1);

  failWith = 'You can only send testing emails to your own email address';
  const bad = await request(app).post('/api/v1/admin/test-email').set(auth(admin.token)).send({ to: addr('probe2') });
  failWith = null;
  assert.strictEqual(bad.status, 502);
  assert.match(bad.body.result.error, /only send testing emails/);

  const st = await request(app).get('/api/v1/admin/email-status').set(auth(admin.token));
  assert.strictEqual(st.body.configured, true);
  assert.strictEqual(st.body.sandbox, false);
  assert.ok(st.body.recent.some((r) => r.status === 'failed'));
});

test('vet/supplier sign-up gets a pending email, then an approval email', async () => {
  const admin = await makeAdmin();
  const v = await farmerWithEmail('Dr Vet', addr('vet'), { role: 'vet' });
  const reg = await request(app).post('/api/v1/auth/register').send({ name: 'Dr Vet', phone: '08' + Math.floor(10000000 + Math.random() * 89999999), password: 'testpass123', role: 'vet', email: addr('vet2') });
  track(reg.body);
  assert.strictEqual(reg.status, 201);
  assert.ok(await waitFor(() => emailsTo(addr('vet2')).some((m) => /received your TFNN sign-up/.test(m.subject))));
  await request(app).patch('/api/v1/admin/users/' + reg.body.user.user_id).set(auth(admin.token)).send({ approved: true });
  assert.ok(await waitFor(() => emailsTo(addr('vet2')).some((m) => /approved/.test(m.subject))));
});

test('task reminders: one digest per farmer per day, secret required', async () => {
  const f = await farmerWithEmail('Task Farmer', addr('tasks'));
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await request(app).post('/api/v1/tasks').set(auth(f.token)).send({ title: 'Dose the weaners', due_date: yesterday });
  await request(app).post('/api/v1/tasks').set(auth(f.token)).send({ title: 'Fix the water trough', due_date: yesterday });
  await new Promise((r) => setTimeout(r, 200));

  assert.strictEqual((await request(app).post('/api/v1/jobs/task-reminders')).status, 401);
  assert.strictEqual((await request(app).post('/api/v1/jobs/task-reminders').set('x-cron-secret', 'wrong')).status, 401);

  sent.length = 0;
  const run1 = await request(app).post('/api/v1/jobs/task-reminders').set('x-cron-secret', 'cron-test-secret');
  assert.strictEqual(run1.status, 200);
  const mine = emailsTo(addr('tasks'));
  assert.strictEqual(mine.length, 1);
  assert.match(mine[0].subject, /2 tasks/);
  assert.ok(mine[0].text.includes('Dose the weaners') && mine[0].text.includes('Fix the water trough'));

  sent.length = 0;
  await request(app).post('/api/v1/jobs/task-reminders').set('x-cron-secret', 'cron-test-secret');
  assert.strictEqual(emailsTo(addr('tasks')).length, 0, 'same farmer must not get a second digest today');

  delete process.env.CRON_SECRET;
  assert.strictEqual((await request(app).post('/api/v1/jobs/task-reminders').set('x-cron-secret', 'cron-test-secret')).status, 503);
  process.env.CRON_SECRET = 'cron-test-secret';
});

test('without an API key email is skipped, never crashes the request', async () => {
  const key = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const before = sent.length;
  const a = await farmerWithEmail('Keyless', addr('keyless'));
  assert.strictEqual(a.status, 201);
  await new Promise((r) => setTimeout(r, 250));
  assert.strictEqual(sent.length, before);
  process.env.RESEND_API_KEY = key;
});
