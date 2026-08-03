const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL Pool Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Database Initialization
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "email" VARCHAR(255) UNIQUE NOT NULL,
        "identityTrustLevel" VARCHAR(50) DEFAULT 'LEVEL_1',
        "createdAt" TIMESTAMP DEFAULT NOW(),
        "updatedAt" TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS "evidence_artifacts" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "title" VARCHAR(255) NOT NULL,
        "description" TEXT,
        "eClass" VARCHAR(100) NOT NULL,
        "sourceUri" VARCHAR(500),
        "aiConfidenceScore" NUMERIC(3, 2),
        "observedAt" TIMESTAMP DEFAULT NOW(),
        "createdAt" TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS "opportunities" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "title" VARCHAR(255) NOT NULL,
        "company" VARCHAR(255) DEFAULT 'Proof OS Network',
        "minTrustLevel" VARCHAR(50) NOT NULL,
        "requiredEClass" VARCHAR(100) NOT NULL,
        "reward" VARCHAR(255) DEFAULT 'N/A',
        "createdAt" TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS "certificates" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "title" VARCHAR(255) NOT NULL,
        "issuer" VARCHAR(255) DEFAULT 'Proof OS Network',
        "eClass" VARCHAR(100) NOT NULL,
        "verificationHash" VARCHAR(255) NOT NULL UNIQUE,
        "issuedAt" TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS "marketplace_listings" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "category" VARCHAR(50) NOT NULL,
        "title" VARCHAR(255) NOT NULL,
        "description" TEXT,
        "price" NUMERIC(10, 2) NOT NULL,
        "priceUnit" VARCHAR(50) NOT NULL,
        "location" VARCHAR(255) NOT NULL,
        "district" VARCHAR(100) DEFAULT 'Kamrup',
        "isAvailable" BOOLEAN DEFAULT TRUE,
        "createdAt" TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS "rental_bookings" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "listingId" UUID NOT NULL REFERENCES "marketplace_listings"("id") ON DELETE CASCADE,
        "renterUserId" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "startDate" TIMESTAMP NOT NULL,
        "endDate" TIMESTAMP NOT NULL,
        "totalAmount" NUMERIC(10, 2) NOT NULL,
        "status" VARCHAR(50) DEFAULT 'PENDING',
        "createdAt" TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ All PostgreSQL database tables initialized successfully!');
  } catch (err) {
    console.error('❌ Database Initialization Error:', err);
  }
}

initDatabase();

// 1. Health Check & Root
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'proof-os-backend', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.send('🚀 Proof OS Backend API running active');
});

// 2. User Routes
app.post('/api/users', async (req, res) => {
  const { email, identityTrustLevel } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const existing = await pool.query('SELECT * FROM "users" WHERE "email" = $1', [email]);
    if (existing.rows.length > 0) return res.json({ success: true, user: existing.rows[0] });

    const newUser = await pool.query(
      'INSERT INTO "users" ("email", "identityTrustLevel") VALUES ($1, $2) RETURNING *',
      [email, identityTrustLevel || 'LEVEL_1']
    );
    res.status(201).json({ success: true, user: newUser.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed user operation', details: err.message });
  }
});

// 3. Evidence Routes
app.post('/api/evidence', async (req, res) => {
  const { userId, title, description, eClass, sourceUri, aiConfidenceScore } = req.body;
  if (!userId || !title || !eClass) return res.status(400).json({ error: 'Missing parameters' });

  try {
    const result = await pool.query(
      `INSERT INTO "evidence_artifacts" ("userId", "title", "description", "eClass", "sourceUri", "aiConfidenceScore") 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [userId, title, description, eClass, sourceUri, aiConfidenceScore]
    );
    res.status(201).json({ success: true, artifact: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to record evidence', details: err.message });
  }
});

// 4. Opportunity Routes
app.post('/api/opportunities', async (req, res) => {
  const { title, company, minTrustLevel, requiredEClass, reward } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO "opportunities" ("title", "company", "minTrustLevel", "requiredEClass", "reward")
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [title, company || 'Proof OS Network', minTrustLevel, requiredEClass, reward || 'N/A']
    );
    res.status(201).json({ success: true, opportunity: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed creating opportunity', details: err.message });
  }
});

app.get('/api/opportunities/match/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const userRes = await pool.query('SELECT * FROM "users" WHERE "id" = $1', [userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const evidenceRes = await pool.query(
      'SELECT DISTINCT "eClass" FROM "evidence_artifacts" WHERE "userId" = $1',
      [userId]
    );
    const verifiedEClasses = evidenceRes.rows.map(row => row.eClass);

    let opportunities = [];
    if (verifiedEClasses.length > 0) {
      const oppRes = await pool.query(
        'SELECT * FROM "opportunities" WHERE "requiredEClass" = ANY($1::varchar[])',
        [verifiedEClasses]
      );
      opportunities = oppRes.rows;
    }

    res.json({
      userId,
      verifiedEClasses,
      matchCount: opportunities.length,
      opportunities
    });
  } catch (err) {
    res.status(500).json({ error: 'Matching failed', details: err.message });
  }
});

// 5. Certificate Routes
app.post('/api/certificates/issue', async (req, res) => {
  const { userId, title, eClass } = req.body;
  if (!userId || !title || !eClass) return res.status(400).json({ error: 'Missing parameters' });

  try {
    const rawData = `${userId}-${eClass}-${Date.now()}`;
    const verificationHash = '0x' + crypto.createHash('sha256').update(rawData).digest('hex');

    const certRes = await pool.query(
      `INSERT INTO "certificates" ("userId", "title", "eClass", "verificationHash")
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [userId, title, eClass, verificationHash]
    );

    res.status(201).json({ success: true, certificate: certRes.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed issuing certificate', details: err.message });
  }
});

app.get('/api/certificates/verify/:certIdOrHash', async (req, res) => {
  const { certIdOrHash } = req.params;
  try {
    const certRes = await pool.query(
      `SELECT c.*, u.email as "recipientEmail" FROM "certificates" c 
       JOIN "users" u ON c."userId" = u.id 
       WHERE c.id::text = $1 OR c."verificationHash" = $1`,
      [certIdOrHash]
    );

    if (certRes.rows.length === 0) return res.status(404).json({ valid: false });
    res.json({ valid: true, certificate: certRes.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Verification failed', details: err.message });
  }
});

// 6. SAMPARK Hub Routes
app.post('/api/sampark/listings', async (req, res) => {
  const { userId, category, title, description, price, priceUnit, location, district } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO "marketplace_listings" ("userId", "category", "title", "description", "price", "priceUnit", "location", "district") 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [userId, category, title, description, price, priceUnit, location, district || 'Kamrup']
    );
    res.status(201).json({ success: true, listing: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed listing', details: err.message });
  }
});

app.get('/api/sampark/listings', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM "marketplace_listings" WHERE "isAvailable" = TRUE ORDER BY "createdAt" DESC`);
    res.json({ success: true, count: result.rowCount, listings: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed fetching listings', details: err.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server active on port ${PORT}`);
});
