const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const fileUpload = require('express-fileupload');
const axios = require('axios');
const FormData = require('form-data');

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use(fileUpload({ limits: { fileSize: 50 * 1024 * 1024 } })); // 50MB limit

const JWT_SECRET = process.env.JWT_SECRET || 'proof_os_secret_key_123';

// Auth Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

// Magic Link Auth Token Route
app.post('/api/auth/token', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({ data: { email, trustLevel: 'LEVEL_1' } });
  }

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ success: true, token });
});

// AI Video Transcribe & Verify Endpoint
app.post('/api/evidence/transcribe-verify', authenticateToken, async (req, res) => {
  try {
    if (!req.files || !req.files.videoFile) {
      return res.status(400).json({ error: "No video file uploaded." });
    }

    const video = req.files.videoFile;
    
    // Whisper API Transcription
    const formData = new FormData();
    formData.append('file', video.data, { filename: video.name });
    formData.append('model', 'whisper-1');

    const whisperRes = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
      headers: {
        ...formData.getHeaders(),
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      }
    });

    const transcript = whisperRes.data.text || "";

    // Skill Extraction
    const extractRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are an expert evaluator. Analyze transcript and return JSON: {"eClass": "ENGINEERING_E4", "skillsDetected": ["React", "Node.js"]}'
        },
        { role: 'user', content: `Transcript: ${transcript}` }
      ],
      response_format: { type: "json_object" }
    }, {
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }
    });

    const analysis = JSON.parse(extractRes.data.choices[0].message.content);

    const newArtifact = await prisma.artifact.create({
      data: {
        userId: req.user.id,
        title: req.body.title || "AI Video Proof Demo",
        eClass: analysis.eClass || "ENGINEERING_E2",
        sourceUri: `video://${video.name}`,
        trustLevel: "LEVEL_3_VERIFIED",
        verificationHash: "0x" + Buffer.from(Date.now().toString()).toString('hex')
      }
    });

    res.json({ success: true, transcript, analysis, artifact: newArtifact });
  } catch (err) {
    res.status(500).json({ error: "Transcription processing failed." });
  }
});

// User Evidence Artifacts
app.get('/api/evidence/user/me', authenticateToken, async (req, res) => {
  const artifacts = await prisma.artifact.findMany({ where: { userId: req.user.id } });
  res.json({ artifacts });
});

// Active Opportunities Endpoint
app.get('/api/opportunities', async (req, res) => {
  const opportunities = await prisma.opportunity.findMany();
  res.json(opportunities);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
