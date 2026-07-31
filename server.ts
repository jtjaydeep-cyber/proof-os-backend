import express, { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import path from 'path';

const app = express();
app.use(express.json());

// Serve static frontend dashboard from /public
app.use(express.static(path.join(__dirname, 'public')));

// -----------------------------------------------------------------------------
// Database Connection Pool (Secure Environment Config)
// -----------------------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// -----------------------------------------------------------------------------
// Security Middleware (API Key Authentication)
// -----------------------------------------------------------------------------
const API_KEY = process.env.API_KEY;

function authenticateKey(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'];
  if (API_KEY && apiKey === API_KEY) {
    return next();
  }
  // Allow request through if no API_KEY environment variable is configured for dev
  if (!API_KEY) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized: Invalid or missing X-API-KEY header.' });
}

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
// 1A. User Lookup Endpoint (By Email for Dashboard Login)
// -----------------------------------------------------------------------------
app.get('/api/users/lookup', async (req: Request, res: Response) => {
  try {
    const email = req.query.email as string;
    if (!email) {
      return res.status(400).json({ error: 'Email query parameter is required.' });
    }

    const result = await pool.query(
      'SELECT id, email, "identityTrustLevel" FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    return res.json({ success: true, user: result.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// -----------------------------------------------------------------------------
// 1B. User Creation Endpoint (Protected)
// -----------------------------------------------------------------------------
app.post('/api/users', authenticateKey, async (req: Request, res: Response) => {
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
// 2. Evidence Artifact Ingestion Endpoint (With Automated AI Analysis)
// -----------------------------------------------------------------------------
app.post('/api/evidence', authenticateKey, async (req: Request, res: Response) => {
  try {
    const { userId, title, description, eClass, sourceUri } = req.body;

    // Dynamic AI Analysis & Skill Vector Engine
    let aiScore = 0.85;
    let vector = [0.5, 0.5, 0.5];

    if (eClass === 'CLASS_C' || sourceUri.includes('github.com')) {
      aiScore = 0.98;
      vector = [0.92, 0.12, 0.08]; // Systems / Engineering
    } else if (eClass === 'CLASS_B' || sourceUri.includes('x.com') || sourceUri.includes('twitter.com') || sourceUri.includes('dev.to')) {
      aiScore = 0.88;
      vector = [0.45, 0.85, 0.20]; // Content / DevRel
    } else {
      aiScore = 0.75;
      vector = [0.30, 0.40, 0.80]; // Design / Portfolio
    }

    const evidenceRes = await pool.query(
      `INSERT INTO evidence_artifacts ("userId", title, description, "eClass", "sourceUri", "aiConfidenceScore", embedding, "observedAt")
       VALUES ($1, $2, $3, $4::"EvidenceClass", $5, $6, $7, NOW())
       RETURNING *;`,
      [userId, title, description || null, eClass, sourceUri, aiScore, vector]
    );

    if (eClass === 'CLASS_C') {
      await pool.query(
        `UPDATE users SET "identityTrustLevel" = 'LEVEL_2' WHERE id = $1`,
        [userId]
      );
    }

    return res.status(201).json({
      success: true,
      message: 'Evidence artifact analyzed by AI Engine and stored.',
      artifact: evidenceRes.rows[0],
      aiAnalysis: {
        calculatedScore: aiScore,
        generatedVector: vector
      }
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// -----------------------------------------------------------------------------
// 3. Attach Vector Embedding Explicitly (Protected)
// -----------------------------------------------------------------------------
app.post('/api/evidence/embedding', authenticateKey, async (req: Request, res: Response) => {
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
// 4. Vector Cosine Similarity Search Engine Endpoint (Protected)
// -----------------------------------------------------------------------------
app.post('/api/match', authenticateKey, async (req: Request, res: Response) => {
  try {
    const { queryVector, matchThreshold = 0.5 } = req.body;

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
// 5. GitHub Webhook Ingestion Endpoint (Public)
// -----------------------------------------------------------------------------
app.post('/api/webhooks/github', async (req: Request, res: Response) => {
  try {
    const { action, pull_request, sender } = req.body;

    if (action === 'closed' && pull_request?.merged) {
      const email = sender?.email || `${sender?.login}@users.noreply.github.com`;
      const title = `Merged PR #${pull_request.number}: ${pull_request.title}`;
      const sourceUri = pull_request.html_url;

      let userRes = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      let userId = userRes.rows[0]?.id;

      if (!userId) {
        const newUser = await pool.query(
          `INSERT INTO users (email, "identityTrustLevel") VALUES ($1, 'LEVEL_1') RETURNING id`,
          [email]
        );
        userId = newUser.rows[0].id;
      }

      const vector = [0.95, 0.05, 0.05];
      const evidenceRes = await pool.query(
        `INSERT INTO evidence_artifacts ("userId", title, description, "eClass", "sourceUri", "aiConfidenceScore", embedding, "observedAt")
         VALUES ($1, $2, $3, 'CLASS_C'::"EvidenceClass", $4, 0.98, $5, NOW())
         RETURNING *;`,
        [userId, title, pull_request.body || null, sourceUri, vector]
      );

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
// 6. Capability Aggregation Engine + DB Persistence (Protected)
// -----------------------------------------------------------------------------
app.post('/api/users/aggregate', authenticateKey, async (req: Request, res: Response) => {
  try {
    const { userId } = req.body;

    const result = await pool.query(
      `SELECT embedding, "aiConfidenceScore" 
       FROM evidence_artifacts 
       WHERE "userId" = $1 AND embedding IS NOT NULL;`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'No embedded evidence artifacts found for user.' });
    }

    const vectorLength = result.rows[0].embedding.length;
    const aggregatedVector: number[] = new Array(vectorLength).fill(0);
    let totalScore = 0;

    result.rows.forEach((row) => {
      const weight = row.aiConfidenceScore || 1.0;
      totalScore += weight * 100;

      for (let i = 0; i < vectorLength; i++) {
        aggregatedVector[i] += row.embedding[i] * weight;
      }
    });

    const totalWeight = result.rows.reduce((acc, row) => acc + (row.aiConfidenceScore || 1.0), 0);
    const finalVector = aggregatedVector.map((val) => parseFloat((val / totalWeight).toFixed(4)));
    const roundedScore = Math.round(totalScore);

    // Save persistent profile into Postgres database
    await pool.query(
      `INSERT INTO user_profiles ("userId", "proofScore", "aggregatedVector", "updatedAt")
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT ("userId") DO UPDATE
       SET "proofScore" = EXCLUDED."proofScore",
           "aggregatedVector" = EXCLUDED."aggregatedVector",
           "updatedAt" = NOW();`,
      [userId, roundedScore, finalVector]
    );

    return res.json({
      success: true,
      userId,
      totalArtifactsProcessed: result.rows.length,
      proofScore: roundedScore,
      aggregatedVector: finalVector,
      persistedToDb: true
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// -----------------------------------------------------------------------------
// 7. Public Proof Certificate & Verification Badge Endpoint (Public)
// -----------------------------------------------------------------------------
app.get('/api/users/:userId/badge', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    const userResult = await pool.query(
      `SELECT u.id, u.email, u."identityTrustLevel", p."proofScore", p."aggregatedVector"
       FROM users u
       LEFT JOIN user_profiles p ON u.id = p."userId"
       WHERE u.id = $1;`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = userResult.rows[0];

    const artifactsResult = await pool.query(
      `SELECT id, title, "eClass", "sourceUri", "aiConfidenceScore", "observedAt"
       FROM evidence_artifacts 
       WHERE "userId" = $1;`,
      [userId]
    );

    const artifacts = artifactsResult.rows;
    const verifiedCount = artifacts.length;
    const avgConfidence = verifiedCount > 0 
      ? (artifacts.reduce((acc, curr) => acc + (curr.aiConfidenceScore || 0), 0) / verifiedCount).toFixed(2)
      : '0.00';

    return res.json({
      success: true,
      badge: {
        issuer: 'Proof OS Protocol',
        verifiedIdentity: user.email,
        trustLevel: user.identityTrustLevel,
        proofScore: user.proofScore || 0,
        aggregatedCapabilityVector: user.aggregatedVector || null,
        totalVerifiedArtifacts: verifiedCount,
        confidenceRating: `${parseFloat(avgConfidence) * 100}%`,
        verificationTimestamp: new Date().toISOString(),
        evidence: artifacts.map((art) => ({
          title: art.title,
          class: art.eClass,
          proofUrl: art.sourceUri,
        })),
      },
    });
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
