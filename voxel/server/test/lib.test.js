const test = require('node:test'), assert = require('node:assert'), L = require('../lib');
test('AC1 hospital pothole with ambulance => score>=80, Tier 1', () => {
  const s = L.severity({ sBase: 8, mGeo: 2.5, mVuln: 25 }); assert.ok(s >= 80); assert.equal(L.tierOf(s), 1); assert.equal(L.SLA_H[1], 12); });
test('AC2 London is outside geofence; Kharagpur inside', () => {
  assert.equal(L.inPoly(51.5074, -0.1278), false); assert.equal(L.inPoly(22.3149, 87.3105), true); });
test('AC3 points 15m apart are within 25m', () => assert.ok(L.dist(22.3149, 87.3105, 22.3150, 87.3106) < 25));
test('velocity boost capped at 25; score capped at 100', () => {
  assert.equal(L.velocity(1e9), 25); assert.equal(L.severity({ sBase: 10, mGeo: 3, mVuln: 25, n: 50 }), 100); });
test('AC6 user token is a salted hash, masked id hides it', () => {
  const t = L.userToken('+919876543210'); assert.match(t, /^[0-9a-f]{64}$/); assert.ok(!L.maskedId(t).includes('9876')); });
test('AC4 diff rejects distant after-photo', async () => {
  const r = await L.visualDiff(Buffer.from('a'), Buffer.from('b'), { lat: 22.31, lng: 87.31 }, { lat: 22.5, lng: 87.5 });
  assert.equal(r.ok, false); assert.match(r.reason, /landmarks do not match/); });
