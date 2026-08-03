require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  console.log('⚡ Connecting directly to Proof OS Database...');
  
  // 1. Insert User
  const userRes = await pool.query(`
    INSERT INTO "users" ("email", "identityTrustLevel", "updatedAt")
    VALUES ($1, $2, NOW())
    ON CONFLICT ("email") DO UPDATE SET "updatedAt" = NOW()
    RETURNING *;
  `, ['founder@proof-os.io', 'LEVEL_1']);
  
  console.log('✅ User created/updated:', userRes.rows[0]);

  // 2. Insert Evidence Artifact
  const evidenceRes = await pool.query(`
    INSERT INTO "evidence_artifacts" (
      "userId", "title", "description", "eClass", "sourceUri", "aiConfidenceScore", "observedAt"
    ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
    RETURNING *;
  `, [
    userRes.rows[0].id,
    'Initial Proof OS Engine Build',
    'Deployed core PostgreSQL schema via Termux and Render.',
    'CLASS_A',
    'https://github.com/your-org/proof-os-backend',
    0.99
  ]);

  console.log('✅ Evidence Artifact generated:', evidenceRes.rows[0]);
  await pool.end();
}

main().catch((e) => console.error('❌ Error:', e));
