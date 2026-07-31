import express, { Request, Response } from 'express';
import { Pool } from 'pg';

const app = express();
app.use(express.json());

// -----------------------------------------------------------------------------
// Database Connection Pool
// -----------------------------------------------------------------------------
const pool = new Pool({
  user: process.env.PGUSER || 'postgres',
  host: process.env.PGHOST || 'localhost',
  database: process.env.PGDATABASE || 'proof_os',
  password: process.env.PGPASSWORD || '',
  port: parseInt(process.env.PGPORT || '5432'),
});

// Helper: Cosine Similarity Vector Math
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// -----------------------------------------------------------------------------
// 1. User Creation Endpoint
// -----------------------------------------------------------------------------
app.post('/api/users', async (req: Request, res: Response) => {
  try {
    const { email, identityTrustLevel } = req.body;
    const result = await pool.query(
      `INSERT INTO users (email, "identityTrustLevel")
       VALUES ($1, $2)
       RETURNING *;`,
      [email, identityTrustLevel || 'LEVEL_1']
    );
    return res.status(201).json({ success: true, user: result.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// -----------------------------------------------------------------------------
// 2. Evidence Artifact Ingestion & Auto-Trust Escalation Endpoint
// -----------------------------------------------------------------------------
app.post('/api/evidence', async (req: Request, res: Response) => {
  try {
    const { userId, title, description, eClass, sourceUri, aiConfidenceScore } = req.body;

    // 1. Ingest Evidence Artifact
    const evidenceRes = await pool.query(
      `INSERT INTO evidence_artifacts ("userId", title, description, "eClass", "sourceUri", "aiConfidenceScore", "observedAt")
       VALUES ($1, $2, $3, $4::"EvidenceClass", $5, $6, NOW())
       RETURNING *;`,
      [userId, title, description || null, eClass, sourceUri, aiConfidenceScore]
    );

    // 2. Automated Trust Level Upgrade Trigger
    if (eClass === 'CLASS_C') {
      await pool.query(
        `UPDATE users SET "identityTrustLevel" = 'LEVEL_2' WHERE id = $1`,
        [userId]
      );
    }

    return res.status(201).json({
      success: true,
      message: 'Evidence artifact successfully ingested and verified.',
      artifact: evidenceRes.rows[0],
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// -----------------------------------------------------------------------------
// 3. Update Evidence Artifact with Vector Embedding Array
// -----------------------------------------------------------------------------
app.post('/api/evidence/embedding', async (req: Request, res: Response) => {
  try {
    const { artifactId, embedding } = req.body;
    const result = await pool.query(
      `UPDATE evidence_artifacts
       SET embedding = $1
       WHERE id = $2
       RETURNING id, title, "eClass", embedding;`,
      [embedding, artifactId]
    );
    return res.json({ success: true, artifact: result.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// -----------------------------------------------------------------------------
// 4. Vector Cosine Similarity Search Engine Endpoint
// -----------------------------------------------------------------------------
app.post('/api/match', async (req: Request, res: Response) => {
  try {
    const { queryVector, matchThreshold = 0.7 } = req.body;

    const result = await pool.query(
      `SELECT e.id as artifact_id, e.title, e."eClass", e.embedding, u.email, u."identityTrustLevel"
       FROM evidence_artifacts e
       JOIN users u ON e."userId" = u.id
       WHERE e.embedding IS NOT NULL;`
    );

    const matches = result.rows
      .map((row) => {
        const similarity = cosineSimilarity(queryVector, row.embedding);
        return {
          artifact_id: row.artifact_id,
          title: row.title,
          eClass: row.eClass,
          email: row.email,
          identityTrustLevel: row.identityTrustLevel,
          similarity_score: parseFloat(similarity.toFixed(4)),
        };
      })
      .filter((match) => match.similarity_score >= matchThreshold)
      .sort((a, b) => b.similarity_score - a.similarity_score);

    return res.json({ success: true, count: matches.length, matches });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// -----------------------------------------------------------------------------
// 5. GitHub Webhook Ingestion Endpoint
// -----------------------------------------------------------------------------
app.post('/api/webhooks/github', async (req: Request, res: Response) => {
  try {
    const { action, pull_request, sender } = req.body;

    // Process merged Pull Requests
    if (action === 'closed' && pull_request?.merged) {
      const email = sender?.email || `${sender?.login}@users.noreply.github.com`;
      const title = `Merged PR #${pull_request.number}: ${pull_request.title}`;
      const sourceUri = pull_request.html_url;

      // 1. Locate or register user
      let userRes = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      let userId = userRes.rows[0]?.id;

      if (!userId) {
        const newUser = await pool.query(
          `INSERT INTO users (email, "identityTrustLevel") VALUES ($1, 'LEVEL_1') RETURNING id`,
          [email]
        );
        userId = newUser.rows[0].id;
      }

      // 2. Ingest Evidence (PR merges = CLASS_C)
      const evidenceRes = await pool.query(
        `INSERT INTO evidence_artifacts ("userId", title, description, "eClass", "sourceUri", "aiConfidenceScore", "observedAt")
         VALUES ($1, $2, $3, 'CLASS_C'::"EvidenceClass", $4, 0.98, NOW())
         RETURNING *;`,
        [userId, title, pull_request.body || null, sourceUri]
      );

      // 3. Auto-promote Trust Level to LEVEL_2
      await pool.query(
        `UPDATE users SET "identityTrustLevel" = 'LEVEL_2' WHERE id = $1`,
        [userId]
      );

      console.log(`🤖 Automated Ingestion: Created evidence for ${email}`);

      return res.status(201).json({
        success: true,
        automated: true,
        artifact: evidenceRes.rows[0],
      });
    }

    return res.json({ message: 'Webhook received (event ignored).' });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// -----------------------------------------------------------------------------
// Server Initialization
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`⚡ Proof OS Server running at http://localhost:${PORT}`);
});
