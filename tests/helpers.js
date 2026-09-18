const request = require('supertest');
const app = require('../src/index');
const crypto = require('crypto');

function randomPhone() {
  return '08' + Math.floor(10000000 + Math.random() * 89999999);
}

// Registers a fresh farmer (auto-approved, no admin step needed) and returns
// their token so tests can act as them. Each call uses a fresh random phone
// number so tests never collide with each other or with previous runs.
async function registerFarmer(overrides = {}) {
  const phone = overrides.phone || randomPhone();
  const password = overrides.password || 'testpass123';
  const res = await request(app).post('/api/v1/auth/register').send({
    name: overrides.name || 'Test Farmer',
    phone,
    password,
    role: 'farmer',
    farm_location: overrides.farm_location,
  });
  return { ...res.body, phone, password };
}

module.exports = { request, app, randomPhone, registerFarmer, crypto };
