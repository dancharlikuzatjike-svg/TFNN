const db = require('../db');
const { generateAutoTasks } = require('../routes/tasks');
const { sendEmail, composeEmail, sleep, appUrl } = require('./email');

// Emails each farmer ONE digest of their overdue / due-today tasks.
// - skips farmers with no email or who opted out
// - never sends a farmer more than one digest per day (checked against email_log)
// - refreshes auto-generated tasks first (follow-ups, stuck orders) so the digest is current
const DEFAULT_PACE_MS = process.env.EMAIL_PACE_MS !== undefined ? Number(process.env.EMAIL_PACE_MS) : 150;
async function sendTaskReminders({ paceMs = DEFAULT_PACE_MS } = {}) {
  const farmers = await db.query(
    `SELECT user_id FROM users
     WHERE role = 'farmer' AND active = true AND approved = true
       AND email IS NOT NULL AND email_opt_out = false`
  );
  for (const f of farmers.rows) {
    try { await generateAutoTasks(f.user_id); } catch (e) { /* one farmer's data issue must not stop the run */ }
  }

  const due = await db.query(
    `SELECT u.user_id, u.name, u.email,
            json_agg(json_build_object('title', t.title, 'due', t.due_date) ORDER BY t.due_date, t.task_id) AS tasks,
            COUNT(*)::int AS n
     FROM users u
     JOIN task t ON t.farmer_id = u.user_id AND t.done = false AND t.due_date IS NOT NULL AND t.due_date <= CURRENT_DATE
     WHERE u.role = 'farmer' AND u.active = true AND u.approved = true
       AND u.email IS NOT NULL AND u.email_opt_out = false
       AND NOT EXISTS (
         SELECT 1 FROM email_log l
         WHERE l.user_id = u.user_id AND l.kind = 'task_digest' AND l.status = 'sent'
           AND l.created_at::date = CURRENT_DATE)
     GROUP BY u.user_id, u.name, u.email`
  );

  const stats = { farmers_with_email: farmers.rows.length, with_due_tasks: due.rows.length, emailed: 0, failed: 0 };
  for (const row of due.rows) {
    const shown = row.tasks.slice(0, 15);
    const lines = shown.map((t) => `• ${t.title} (due ${String(t.due).slice(0, 10)})`);
    if (row.n > shown.length) lines.push(`…and ${row.n - shown.length} more`);
    const subject = row.n === 1 ? 'You have 1 task to do on your farm' : `You have ${row.n} tasks to do on your farm`;
    const { html, text } = composeEmail({
      heading: subject,
      paragraphs: [`Hi ${row.name}, these tasks are due or overdue:`, lines.join('\n')],
      button: { text: 'Open my tasks', url: appUrl() },
    });
    const r = await sendEmail({ to: row.email, subject, text, html, kind: 'task_digest', userId: row.user_id });
    if (r.sent) stats.emailed++; else stats.failed++;
    await sleep(paceMs);
  }
  return stats;
}

module.exports = { sendTaskReminders };
