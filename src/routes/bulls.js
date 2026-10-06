const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const DAY = 86400000;
const BULL_TYPES = [
  'Breeding Soundness Exam', 'Joined Herd', 'Removed from Herd', 'Body Condition Score',
  'Hoof / Foot Care', 'Vaccinated', 'Dosed / Dewormed', 'Dipped / Tick Control', 'Sick / Treated',
];

// Guidance used for the warnings (general good practice - the app says to confirm with a vet).
const BSE_DUE_AFTER_DAYS = 365;      // breeding soundness exam once a year, before the breeding season
const BSE_WARN_AFTER_DAYS = 300;     // start nudging ~2 months before it lapses
const MAX_JOINED_DAYS = 90;          // a bull should not stay with the cows past one cycle-season (~3 months)
const REST_DAYS = 60;                // rest and regain condition before the next season
const COWS_PER_MATURE_BULL = 25;
const COWS_PER_YOUNG_BULL = 15;      // bulls under 24 months handle fewer cows
const SERVICE_DOSE_DAYS = 180;       // deworm/dip check every ~6 months
const VACC_DAYS = 365;

const toDate = (v) => (v ? new Date(v).getTime() : null);
const daysSince = (t, now) => (t == null ? null : Math.floor((now - t) / DAY));
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

// GET /api/v1/bulls - every active bull with its care status, plus herd bull-to-cow guidance
router.get('/', async (req, res, next) => {
  try {
    const now = Date.now();
    const bullsRes = await db.query(
      `SELECT animal_id, tag_number, breed, date_of_birth
       FROM animal
       WHERE owner_id = $1 AND species = 'Cattle' AND class = 'Bull' AND status = 'Active'
       ORDER BY tag_number`,
      [req.auth.user_id]
    );
    const herdRes = await db.query(
      `SELECT COUNT(*) FILTER (WHERE class IN ('Cow','Heifer'))::int AS females,
              COUNT(*) FILTER (WHERE class = 'Cow')::int AS cows
       FROM animal WHERE owner_id = $1 AND species = 'Cattle' AND status = 'Active'`,
      [req.auth.user_id]
    );
    const ids = bullsRes.rows.map((b) => b.animal_id);
    const events = ids.length
      ? (await db.query(
          `SELECT animal_id, event_type, event_date, notes, metadata
           FROM animal_event
           WHERE animal_id = ANY($1) AND deleted_at IS NULL AND superseded_by IS NULL
             AND event_type = ANY($2)
           ORDER BY event_date DESC, event_id DESC`,
          [ids, BULL_TYPES]
        )).rows
      : [];

    const byBull = new Map(ids.map((id) => [id, []]));
    events.forEach((e) => byBull.get(e.animal_id).push(e));

    const bulls = bullsRes.rows.map((b) => {
      const evs = byBull.get(b.animal_id);
      const last = (type) => evs.find((e) => e.event_type === type) || null;
      const ageMonths = b.date_of_birth ? Math.floor((now - toDate(b.date_of_birth)) / (DAY * 30.44)) : null;
      const alerts = [];

      // Breeding soundness exam
      const bse = last('Breeding Soundness Exam');
      const bseDays = bse ? daysSince(toDate(bse.event_date), now) : null;
      const bseResult = bse && bse.metadata && bse.metadata.result ? String(bse.metadata.result) : null;
      let bseStatus = 'ok';
      if (!bse) { bseStatus = 'none'; alerts.push({ level: 'warn', text: 'No breeding soundness exam recorded. Have your vet examine him 30–60 days before breeding.' }); }
      else if (bseResult === 'Fail') { bseStatus = 'failed'; alerts.push({ level: 'bad', text: 'Failed his last breeding soundness exam — do not use until re-tested and passed.' }); }
      else if (bseDays > BSE_DUE_AFTER_DAYS) { bseStatus = 'overdue'; alerts.push({ level: 'bad', text: `Breeding soundness exam is overdue (${bseDays} days ago).` }); }
      else if (bseDays > BSE_WARN_AFTER_DAYS) { bseStatus = 'due_soon'; alerts.push({ level: 'warn', text: 'Breeding soundness exam due soon — book your vet before the next season.' }); }
      else if (bseResult === 'Deferred') { bseStatus = 'deferred'; alerts.push({ level: 'warn', text: 'Exam was deferred — re-test before breeding.' }); }

      // Joined / removed: is he with the cows right now?
      const joined = evs.find((e) => e.event_type === 'Joined Herd');
      const removed = evs.find((e) => e.event_type === 'Removed from Herd');
      const joinedT = joined ? toDate(joined.event_date) : null;
      const removedT = removed ? toDate(removed.event_date) : null;
      const withHerd = joinedT != null && (removedT == null || joinedT > removedT);
      const daysWithHerd = withHerd ? daysSince(joinedT, now) : null;
      const daysResting = !withHerd && removedT != null ? daysSince(removedT, now) : null;
      if (withHerd && daysWithHerd > MAX_JOINED_DAYS) {
        alerts.push({ level: 'bad', text: `Has been with the cows ${daysWithHerd} days. Take him out after about ${MAX_JOINED_DAYS} days so calving stays tight.` });
      }
      if (daysResting != null && daysResting < REST_DAYS) {
        alerts.push({ level: 'info', text: `Resting — ${REST_DAYS - daysResting} more days to regain condition before the next season.` });
      }

      // Body condition (1–9 scale; bulls going into breeding should be about 6–7)
      const bcsEv = last('Body Condition Score');
      const bcs = bcsEv && bcsEv.metadata && bcsEv.metadata.score != null ? Number(bcsEv.metadata.score) : null;
      if (bcs != null && bcs < 5) alerts.push({ level: 'bad', text: `Body condition ${bcs}/9 is thin — feed him up before and during breeding.` });
      else if (bcs != null && bcs > 7) alerts.push({ level: 'warn', text: `Body condition ${bcs}/9 is very fat — fat bulls breed poorly and go lame.` });
      else if (bcsEv && daysSince(toDate(bcsEv.event_date), now) > 60 && withHerd) alerts.push({ level: 'info', text: 'Score his body condition again — it is over 60 days old.' });

      // Routine health
      const vacc = last('Vaccinated');
      const dose = last('Dosed / Dewormed');
      const dip = last('Dipped / Tick Control');
      const feet = last('Hoof / Foot Care');
      if (!vacc || daysSince(toDate(vacc.event_date), now) > VACC_DAYS) alerts.push({ level: 'warn', text: 'Vaccinations not recorded in the last year.' });
      if (!dose || daysSince(toDate(dose.event_date), now) > SERVICE_DOSE_DAYS) alerts.push({ level: 'info', text: 'No deworming recorded in the last 6 months.' });

      if (ageMonths != null && ageMonths < 24) {
        alerts.push({ level: 'info', text: `Young bull (${ageMonths} months): give him fewer cows (about ${COWS_PER_YOUNG_BULL}) and let him finish growing.` });
      }

      const summarise = (e) => (e ? { date: ymd(e.event_date), result: e.metadata && (e.metadata.result || e.metadata.score) != null ? (e.metadata.result || e.metadata.score) : null } : null);
      const worst = alerts.some((a) => a.level === 'bad') ? 'bad' : alerts.some((a) => a.level === 'warn') ? 'warn' : 'ok';

      return {
        animal_id: b.animal_id,
        tag_number: b.tag_number,
        breed: b.breed,
        age_months: ageMonths,
        status: worst,
        with_herd: withHerd,
        days_with_herd: daysWithHerd,
        days_resting: daysResting,
        bse: { ...summarise(bse), status: bseStatus, days_ago: bseDays },
        body_condition: bcs,
        last: {
          vaccinated: summarise(vacc),
          dosed: summarise(dose),
          dipped: summarise(dip),
          hoof_care: summarise(feet),
        },
        alerts,
      };
    });

    const females = herdRes.rows[0].females;
    const adultBulls = bulls.filter((b) => b.age_months == null || b.age_months >= 24).length;
    const youngBulls = bulls.length - adultBulls;
    const capacity = adultBulls * COWS_PER_MATURE_BULL + youngBulls * COWS_PER_YOUNG_BULL;
    const herd = {
      breeding_females: females,
      bulls: bulls.length,
      bulls_needed: Math.ceil(females / COWS_PER_MATURE_BULL),
      cows_per_bull: bulls.length ? Math.round((females / bulls.length) * 10) / 10 : null,
      capacity,
      message: !females
        ? 'Add your cows and heifers (class Cow / Heifer) to see how many bulls you need.'
        : !bulls.length
          ? `You have ${females} breeding females and no bulls recorded. You need about ${Math.ceil(females / COWS_PER_MATURE_BULL)} mature bull(s).`
          : females > capacity
            ? `${females} breeding females is more than your bulls can cover (about ${capacity}). Add another bull, or conception rates will suffer.`
            : `Your bulls can cover about ${capacity} cows; you have ${females}. Good.`,
    };

    res.json({ bulls, herd, guidance: { cows_per_mature_bull: COWS_PER_MATURE_BULL, cows_per_young_bull: COWS_PER_YOUNG_BULL } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
