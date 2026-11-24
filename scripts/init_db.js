/**
 * Setup and Seed PostgreSQL Database for SahaTN
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  console.log('🐘 Initializing PostgreSQL for SahaTN...');

  // 1. Connect to postgres system db to check/create 'sahatn'
  const sysClient = new Client({
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: 'postgres',
    database: 'postgres'
  });

  await sysClient.connect();
  const dbCheck = await sysClient.query("SELECT 1 FROM pg_database WHERE datname = 'sahatn'");
  if (dbCheck.rows.length === 0) {
    console.log('📦 Database "sahatn" not found. Creating database "sahatn"...');
    await sysClient.query('CREATE DATABASE sahatn');
    console.log('✅ Database "sahatn" created successfully!');
  } else {
    console.log('ℹ️  Database "sahatn" already exists.');
  }
  await sysClient.end();

  // 2. Connect to 'sahatn' database and apply schema
  const dbClient = new Client({
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: 'postgres',
    database: 'sahatn'
  });

  await dbClient.connect();
  console.log('🔗 Connected to "sahatn" database.');

  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    console.log('📜 Applying schema from server/db/schema.sql...');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await dbClient.query(schemaSql);
    console.log('✅ Schema applied successfully!');
  } else {
    console.error('❌ Schema file missing:', schemaPath);
  }

  await dbClient.end();

  // 3. Migrate seed data from database.json
  const { migrate } = require('./migrate_to_postgres');
  console.log('🚚 Migrating data from JSON to PostgreSQL...');
  await migrate();

  console.log('\n🎉 ALL DONE! PostgreSQL is fully set up and seeded!');
}

main().catch(err => {
  console.error('❌ Error initializing PostgreSQL:', err);
  process.exit(1);
});
