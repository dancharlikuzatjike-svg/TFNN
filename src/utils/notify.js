const db = require('../db');

// Finds on-call vets and pages them about a new request.
// This is a stub: it looks up the right people and logs what WOULD be sent.
// Wire in a real gateway (e.g. Africa's Talking, Twilio) by replacing the
// console.log calls below with actual API calls - the rest of the app doesn't
// need to change since it only calls notifyOnCallVets(request).
async function notifyOnCallVets(request) {
  const result = await db.query(
    `SELECT u.user_id, u.name, u.phone FROM vet_profile v
     JOIN users u ON u.user_id = v.vet_id
     WHERE v.on_call = true`
  );

  for (const vet of result.rows) {
    console.log(
      `[SMS STUB] To ${vet.name} (${vet.phone}): New ${request.urgency} vet request ` +
      `from farmer #${request.farmer_id}. Call ${request.phone} to respond.`
    );
    // Example of what a real integration would look like:
    // await smsGateway.send({ to: vet.phone, body: `...` });
  }

  return result.rows.length;
}

module.exports = { notifyOnCallVets };
