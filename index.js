require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// API Key Auth Middleware
const authenticateKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const expectedKey = process.env.API_KEY;

  if (expectedKey && apiKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing X-API-KEY header.' });
  }
  next();
};

app.use(authenticateKey);

// Database Pool Configuration with SSL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Health Check Route
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Proof OS Backend', timestamp: new Date() });
});

// -----------------------------------------------------------------------------
// USER ROUTES
// -----------------------------------------------------------------------------

// Create or Update User
app.post('/api/users', async (req, res) => {
  const { email, identityTrustLevel } = req.body;
  
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

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
    console.error('Error creating user:', err);
    res.status(500).json({ error: 'Failed to create user', details: err.message });
  }
});

// Fetch User by Email
app.get('/api/users/:email', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM "users" WHERE "email" = $1;`, [req.params.email]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// EVIDENCE ARTIFACT ROUTES
// -----------------------------------------------------------------------------

// Create Evidence Artifact
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
    console.error('Error creating evidence artifact:', err);
    res.status(500).json({ error: 'Failed to record evidence', details: err.message });
  }
});

// Get All Evidence Artifacts for a User
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

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Proof OS Backend running on http://localhost:${PORT}`);
});
