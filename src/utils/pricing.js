const db = require('../db');

const num = (name, dflt) => (process.env[name] !== undefined && process.env[name] !== '' && !Number.isNaN(Number(process.env[name])) ? Number(process.env[name]) : dflt);

// All amounts are Namibian dollars. Every value can be overridden with an environment variable.
const PRICING = () => ({
  big_farm_from_animals: num('BIG_FARM_FROM', 100),
  huge_farm_from_animals: num('HUGE_FARM_FROM', 300),
  monthly: {
    small_farmer: num('FEE_MONTHLY_SMALL', 300),
    big_farmer: num('FEE_MONTHLY_BIG', 500),
    huge_farmer: num('FEE_MONTHLY_HUGE', 650),
    vet: num('FEE_MONTHLY_VET', 250),
    supplier: num('FEE_MONTHLY_SUPPLIER', 600),
  },
  registration: {
    small_farmer: num('FEE_REG_SMALL', 50),
    big_farmer: num('FEE_REG_BIG', 100),
    huge_farmer: num('FEE_REG_BIG', 100),
    vet: num('FEE_REG_VET', 150),
    supplier: num('FEE_REG_SUPPLIER', 300),
  },
  marketplace_fee_percent: num('MARKETPLACE_FEE_PERCENT', 4),
  trial_days: 30,
});

const TIER_LABEL = { small_farmer: 'Small farmer', big_farmer: 'Big farm', huge_farmer: 'Big farm (300+ animals)', vet: 'Vet', supplier: 'Supplier' };

async function tierFor(user) {
  const p = PRICING();
  if (user.role === 'vet') return 'vet';
  if (user.role === 'supplier') return 'supplier';
  if (user.role !== 'farmer') return null;
  const r = await db.query(`SELECT COUNT(*)::int AS n FROM animal WHERE owner_id = $1 AND status = 'Active'`, [user.user_id]);
  const n = r.rows[0].n;
  if (n >= p.huge_farm_from_animals) return 'huge_farmer';
  if (n >= p.big_farm_from_animals) return 'big_farmer';
  return 'small_farmer';
}

const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

// Works out where an account stands. Admins are never charged.
async function membershipFor(u) {
  const p = PRICING();
  if (u.role === 'admin') return { tier: null, status: 'admin', exempt: true, enforced: enforced() };
  const tier = await tierFor(u);
  const t = today();
  const paidUntil = ymd(u.paid_until);
  const trialEnds = ymd(u.trial_ends);
  let status = 'expired';
  let daysLeft = 0;
  if (paidUntil && paidUntil >= t) { status = 'active'; daysLeft = daysBetween(t, paidUntil); }
  else if (trialEnds && trialEnds >= t && u.role === 'farmer') { status = 'trial'; daysLeft = daysBetween(t, trialEnds); }
  const regDue = !u.reg_fee_paid_on;
  const monthly = p.monthly[tier];
  const registration = p.registration[tier];
  return {
    tier, tier_label: TIER_LABEL[tier], status, days_left: daysLeft,
    paid_until: paidUntil, trial_ends: trialEnds, registration_paid: !regDue,
    monthly_fee: monthly, registration_fee: registration,
    amount_due_now: status === 'active' ? 0 : monthly + (regDue ? registration : 0),
    enforced: enforced(),
  };
}

const enforced = () => String(process.env.BILLING_ENFORCED || '').toLowerCase() === 'true';

module.exports = { PRICING, TIER_LABEL, tierFor, membershipFor, enforced, today };
