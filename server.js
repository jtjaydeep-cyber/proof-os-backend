require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Bulletproof Auth Middleware: accepts 'proof-os-secret-123' OR process.env.API_KEY
const authenticateKey = (req, res, next) => {
  const incomingKey = (req.headers['x-api-key'] || req.headers['X-API-KEY'] || '').toString().trim();
  const validKeys = ['proof-os-secret-123'];
  
  if (process.env.API_KEY && process.env.API_KEY.trim()) {
    validKeys.push(process.env.API_KEY.trim());
  }

  if (!incomingKey || !validKeys.includes(incomingKey)) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing X-API-KEY header.' });
  }
  next();
};

app.use(authenticateKey);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Proof OS Backend', timestamp: new Date() });
});

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

app.get('/api/users/:email', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM "users" WHERE "email" = $1;`, [req.params.email]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.listen(PORT, () => {
  console.log(`🚀 Proof OS Backend running on port ${PORT}`);
});
