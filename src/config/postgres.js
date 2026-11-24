/**
 * SahaTN / Maw2idi — PostgreSQL Database Client & Connection Pool
 * Enterprise Relational Storage Engine for Tunisian Healthcare System
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Determine connection settings from environment
const connectionString = process.env.DATABASE_URL || null;

const poolConfig = connectionString
  ? {
      connectionString,
      ssl: process.env.PGSSL === 'true' || connectionString.includes('sslmode=require') 
        ? { rejectUnauthorized: false } 
        : false,
      max: parseInt(process.env.PGMAX || '50', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000
    }
  : {
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5432', 10),
      database: process.env.PGDATABASE || 'sahatn',
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || 'postgres',
      ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
      max: parseInt(process.env.PGMAX || '50', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000
    };

let pool = null;
let isConnected = false;
let lastError = null;

try {
  pool = new Pool(poolConfig);

  pool.on('error', (err) => {
    console.error('[PostgreSQL] Unexpected error on idle client:', err.message);
  });
} catch (e) {
  lastError = e.message;
  console.warn('[PostgreSQL] Could not create connection pool:', e.message);
}

/**
 * Execute parameterized query on PostgreSQL
 */
async function query(text, params = []) {
  if (!pool) {
    throw new Error('PostgreSQL pool is not initialized');
  }
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.DEBUG_SQL === 'true') {
      console.log('[PostgreSQL] Executed query', { text, duration, rows: res.rowCount });
    }
    return res;
  } catch (err) {
    console.error('[PostgreSQL Query Error]', { text, error: err.message });
    throw err;
  }
}

/**
 * Test PostgreSQL connectivity
 */
async function testConnection() {
  if (!pool) return { ok: false, error: 'Pool uninitialized' };
  try {
    const res = await query('SELECT NOW() as now, current_database() as db, version() as version;');
    isConnected = true;
    lastError = null;
    return {
      ok: true,
      timestamp: res.rows[0].now,
      database: res.rows[0].db,
      version: res.rows[0].version
    };
  } catch (err) {
    isConnected = false;
    lastError = err.message;
    return { ok: false, error: err.message };
  }
}

/**
 * Initialize PostgreSQL Schema from db/schema.sql
 */
async function initSchema() {
  const schemaPath = path.join(__dirname, '..', '..', 'db', 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema file not found at: ${schemaPath}`);
  }
  const sql = fs.readFileSync(schemaPath, 'utf8');
  console.log('🔄 [PostgreSQL] Applying schema from db/schema.sql...');
  await query(sql);
  console.log('✅ [PostgreSQL] Schema applied successfully.');
  return true;
}

module.exports = {
  pool,
  query,
  testConnection,
  initSchema,
  isPostgresConnected: () => isConnected,
  getLastError: () => lastError,
  getConfigSummary: () => ({
    host: poolConfig.host || 'connectionString',
    port: poolConfig.port || 5432,
    database: poolConfig.database || 'from_url',
    user: poolConfig.user || 'from_url',
    hasUrl: Boolean(process.env.DATABASE_URL)
  })
};
