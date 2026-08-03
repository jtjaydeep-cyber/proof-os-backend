require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Database Connection (Forcing SSL for external Render/Neon PostgreSQL DBs)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Proof OS Backend', timestamp: new Date() });
});

// 1. Users Route
app.post('/api/users', async (req, res) => {
  const { email, identityTrustLevel } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const result = await pool.query(`
      INSERT INTO "users" ("email", "identityTrustLevel", "updatedAt")
      VALUES ($1, $2, NOW())
      ON CONFLICT ("email") DO UPDATE SET 
        "identityTrustLevel" = EXCLUDED."identityTrustLevel",
        "updatedAt" = NOW()
      RETURNING *;
    `, [email, identityTrustLevel || 'LEVEL_0']);

    res.status(201).json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create user', details: err.message });
  }
});

// 2. Evidence Artifacts Route
app.post('/api/evidence', async (req, res) => {
  const { userId, title, description, eClass, sourceUri, aiConfidenceScore } = req.body;
  if (!userId || !title || !eClass || !sourceUri) {
    return res.status(400).json({ error: 'userId, title, eClass, and sourceUri are required' });
  }

  try {
    const result = await pool.query(`
      INSERT INTO "evidence_artifacts" (
        "userId", "title", "description", "eClass", "sourceUri", "aiConfidenceScore", "observedAt"
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING *;
    `, [userId, title, description || null, eClass, sourceUri, aiConfidenceScore || 0.0]);

    res.status(201).json({ success: true, artifact: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to record evidence', details: err.message });
  }
});

// Fetch Evidence for User
app.get('/api/evidence/user/:userId', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM "evidence_artifacts" 
      WHERE "userId" = $1 
      ORDER BY "createdAt" DESC;
    `, [req.params.userId]);
    res.json({ count: result.rows.length, artifacts: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Opportunity Engine Routes
app.post('/api/opportunities', async (req, res) => {
  const { title, company, minTrustLevel, requiredEClass, reward } = req.body;
  if (!title || !minTrustLevel || !requiredEClass) {
    return res.status(400).json({ error: 'title, minTrustLevel, and requiredEClass are required' });
  }

  try {
    const result = await pool.query(`
      INSERT INTO "opportunities" ("title", "company", "minTrustLevel", "requiredEClass", "reward", "createdAt")
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *;
    `, [title, company || 'Proof OS Network', minTrustLevel, requiredEClass, reward || 'N/A']);

    res.status(201).json({ success: true, opportunity: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create opportunity', details: err.message });
  }
});

app.get('/api/opportunities/match/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const userRes = await pool.query(`SELECT * FROM "users" WHERE "id" = $1;`, [userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = userRes.rows[0];

    const evidenceRes = await pool.query(`
      SELECT DISTINCT "eClass" FROM "evidence_artifacts" WHERE "userId" = $1;
    `, [userId]);
    const userEClasses = evidenceRes.rows.map(r => r.eClass);

    const matchesRes = await pool.query(`
      SELECT * FROM "opportunities" 
      WHERE "requiredEClass" = ANY($1::text[])
      ORDER BY "createdAt" DESC;
    `, [userEClasses]);

    res.json({
      userId,
      trustLevel: user.identityTrustLevel,
      verifiedEClasses: userEClasses,
      matchCount: matchesRes.rows.length,
      opportunities: matchesRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Proof OS Backend active on port ${PORT}`);
});
