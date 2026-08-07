require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { Resend } = require('resend');

const app = express();
const prisma = new PrismaClient();
const resend = new Resend(process.env.RESEND_API_KEY);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-in-prod';

app.use(cors());
app.use(express.json());

// --- Authentication Middleware ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
};

// --- Health Check ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Proof OS Backend', timestamp: new Date() });
});

// --- Auth Route: Send Real Magic Link (Resend) ---
app.post('/api/auth/magic-link', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: { email, identityTrustLevel: 'LEVEL_0' },
      });
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
    const magicLink = `https://proof-os-backend.vercel.app/?auth_token=${token}`;

    await resend.emails.send({
      from: 'Proof OS <onboarding@resend.dev>',
      to: email,
      subject: 'Your Proof OS Login Link',
      html: `<p>Click <a href="${magicLink}">here</a> to log in to Proof OS.</p>`,
    });

    res.json({ success: true, message: 'Magic link sent to your email!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send magic link', details: err.message });
  }
});

// --- Auth Route: Direct Token Generation ---
app.post('/api/auth/token', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: { email, identityTrustLevel: 'LEVEL_0' },
      });
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user });
  } catch (err) {
    res.status(500).json({ error: 'Auth failed', details: err.message });
  }
});

// --- 1. Users Route ---
app.post('/api/users', async (req, res) => {
  const { email, identityTrustLevel } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const user = await prisma.user.upsert({
      where: { email },
      update: { identityTrustLevel: identityTrustLevel || 'LEVEL_0' },
      create: { email, identityTrustLevel: identityTrustLevel || 'LEVEL_0' },
    });
    res.status(201).json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create user', details: err.message });
  }
});

// --- 2. Evidence Artifacts Routes ---
app.post('/api/evidence', authenticateToken, async (req, res) => {
  const { title, description, eClass, sourceUri, aiConfidenceScore } = req.body;
  const userId = req.user.userId;

  if (!title || !eClass || !sourceUri) {
    return res.status(400).json({ error: 'title, eClass, and sourceUri are required' });
  }

  try {
    const artifact = await prisma.evidenceArtifact.create({
      data: {
        userId,
        title,
        description: description || null,
        eClass,
        sourceUri,
        aiConfidenceScore: aiConfidenceScore ? parseFloat(aiConfidenceScore) : null,
      },
    });
    res.status(201).json({ success: true, artifact });
  } catch (err) {
    res.status(500).json({ error: 'Failed to record evidence artifact', details: err.message });
  }
});

app.get('/api/evidence/user/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const artifacts = await prisma.evidenceArtifact.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ count: artifacts.length, artifacts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 3. Opportunity Engine Routes ---
app.post('/api/opportunities', authenticateToken, async (req, res) => {
  const { title, company, minTrustLevel, requiredEClass, description } = req.body;

  if (!title || !minTrustLevel || !requiredEClass) {
    return res.status(400).json({ error: 'title, minTrustLevel, and requiredEClass are required' });
  }

  try {
    const opportunity = await prisma.opportunity.create({
      data: {
        title,
        company: company || 'Proof OS Network',
        minTrustLevel,
        requiredEClass,
        description: description || null,
      },
    });
    res.status(201).json({ success: true, opportunity });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create opportunity', details: err.message });
  }
});

app.get('/api/opportunities/match/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const evidence = await prisma.evidenceArtifact.findMany({
      where: { userId },
      select: { eClass: true },
      distinct: ['eClass'],
    });

    const userEClasses = evidence.map((e) => e.eClass);

    const opportunities = await prisma.opportunity.findMany({
      where: {
        requiredEClass: { in: userEClasses },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      userId,
      trustLevel: user.identityTrustLevel,
      verifiedEClasses: userEClasses,
      matchCount: opportunities.length,
      opportunities,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Proof OS Backend active on port ${PORT}`);
});

