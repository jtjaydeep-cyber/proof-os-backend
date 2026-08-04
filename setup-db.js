const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const sql = `
-- Drop old tables to eliminate column mismatch
DROP TABLE IF EXISTS certificates CASCADE;
DROP TABLE IF EXISTS social_accounts CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Recreate clean schema
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  identity_trust_level VARCHAR(50) DEFAULT 'LEVEL_1',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE social_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  account_handle VARCHAR(255) NOT NULL,
  profile_url TEXT NOT NULL,
  verification_status VARCHAR(50) DEFAULT 'VERIFIED',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, platform)
);

CREATE TABLE certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  issuer VARCHAR(255) DEFAULT 'Proof OS Network',
  e_class VARCHAR(50) DEFAULT 'CLASS_A',
  verification_hash VARCHAR(255) UNIQUE NOT NULL,
  issued_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
`;

async function run() {
  try {
    console.log('Resetting and rebuilding database tables...');
    await pool.query(sql);
    console.log('✅ All tables successfully created!');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
  } finally {
    await pool.end();
  }
}

run();

