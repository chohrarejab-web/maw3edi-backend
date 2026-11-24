/**
 * SahaTN / Maw2idi — PostgreSQL Integration Test Suite
 * Tests PostgreSQL schema, client, dump generation, and admin SQL endpoints
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const postgres = require('./src/config/postgres');
const db = require('./src/config/database');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';

async function runTests() {
  console.log('======================================================');
  console.log('🐘 TESTING POSTGRESQL DATABASE INTEGRATION');
  console.log(`🌐 Base URL: ${BASE_URL}`);
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  async function check(name, fn) {
    try {
      await fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
      failed++;
    }
  }

  // 1. Verify db/schema.sql exists and contains all required tables
  await check('1. Verify db/schema.sql DDL file exists with all tables', async () => {
    const schemaPath = path.join(__dirname, 'db', 'schema.sql');
    assert.ok(fs.existsSync(schemaPath), 'schema.sql must exist in db/');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    const requiredTables = [
      'users', 'doctors', 'appointments', 'queue',
      'patient_health_records', 'medical_documents',
      'dependents', 'prescriptions', 'reviews',
      'praticien_requests', 'audit_logs', 'revoked_tokens', 'claims'
    ];
    for (const tbl of requiredTables) {
      assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${tbl}`), `Missing table: ${tbl}`);
    }
  });

  // 2. Verify db/sahatn_postgres_dump.sql exists and contains inserts
  await check('2. Verify db/sahatn_postgres_dump.sql dump file exists and is populated', async () => {
    const dumpPath = path.join(__dirname, 'db', 'sahatn_postgres_dump.sql');
    assert.ok(fs.existsSync(dumpPath), 'sahatn_postgres_dump.sql must exist in db/');
    const dump = fs.readFileSync(dumpPath, 'utf8');
    assert.ok(dump.includes('INSERT INTO users'), 'Must have user inserts');
    assert.ok(dump.includes('INSERT INTO doctors'), 'Must have doctor inserts');
    assert.ok(dump.includes('INSERT INTO appointments'), 'Must have appointment inserts');
    assert.ok(dump.length > 50000, `Dump file size should be substantial (got ${dump.length} bytes)`);
  });

  // 3. Verify postgres module interface
  await check('3. Verify postgres module exports required methods', async () => {
    assert.strictEqual(typeof postgres.query, 'function');
    assert.strictEqual(typeof postgres.testConnection, 'function');
    assert.strictEqual(typeof postgres.initSchema, 'function');
    assert.strictEqual(typeof postgres.isPostgresConnected, 'function');
    assert.strictEqual(typeof postgres.getConfigSummary, 'function');
  });

  // 4. Verify database.js exposes postgres helpers
  await check('4. Verify db object in database.js exposes postgres helpers', async () => {
    assert.strictEqual(typeof db.isPostgresConnected, 'function');
    assert.strictEqual(typeof db.pgQuery, 'function');
    assert.strictEqual(typeof db.getPostgresStatus, 'function');
    const status = db.getPostgresStatus();
    assert.ok('connected' in status);
    assert.ok('config' in status);
  });

  // 5. Authenticate as Super Admin and test API endpoints
  let adminToken = null;
  await check('5. Authenticate as Admin to test SQL API endpoints', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@sahatn.tn', password: 'Saha2026!' })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    adminToken = data.token;
    assert.ok(adminToken);
  });

  // 6. Test GET /api/admin/database/postgres-status
  await check('6. GET /api/admin/database/postgres-status returns status payload', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/database/postgres-status`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok('postgres' in data);
    assert.strictEqual(data.schemaFile, 'db/schema.sql');
    assert.strictEqual(data.dumpFile, 'db/sahatn_postgres_dump.sql');
  });

  // 7. Test POST /api/admin/sql
  await check('7. POST /api/admin/sql executes query and returns structured result', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({ query: 'SELECT * FROM doctors LIMIT 5;' })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.rows && data.rows.length > 0, 'Should return doctor rows');
    assert.ok(data.columns && data.columns.length > 0, 'Should return columns');
    assert.ok('executionTimeMs' in data);
  });

  // 8. Test GET /api/admin/database/postgres-dump
  await check('8. GET /api/admin/database/postgres-dump downloads SQL dump', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/database/postgres-dump`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('CREATE TABLE IF NOT EXISTS users'));
    assert.ok(text.includes('INSERT INTO doctors'));
  });

  console.log('\n======================================================');
  console.log(`📊 POSTGRESQL TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================\n');

  if (failed > 0) process.exit(1);
}

if (require.main === module) {
  runTests().catch(err => {
    console.error('Test runner fatal error:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
