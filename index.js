require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const app = express();

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-in-prod';

// 1. Email Transporter (Configured for Resend / SMTP with TLS port 465)
const smtpPort = Number(process.env.SMTP_PORT) || 587;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: smtpPort,
  secure: smtpPort === 465, // True for 465 (TLS), false for 587 (STARTTLS)
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// 2. Helmet Security Headers
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: [
          "'self'",
          'https://pipedapi.kavin.rocks',
          'https://api.github.com',
          'https://leetcode-stats-api.herokuapp.com',
          'https://codeforces.com'
        ]
      }
    }
  })
);

// 3. CORS
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
  })
);

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 4. Rate Limiters
const verificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many verification attempts. Please try again after 15 minutes.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many magic link requests. Please check your inbox or wait 15 minutes.' }
});

// 5. Database Connection Pool
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1
});

// 6. Database Migration Strategy
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        identity_trust_level VARCHAR(50) DEFAULT 'LEVEL_1',
        magic_token_hash VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS social_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        platform VARCHAR(50) NOT NULL,
        account_handle VARCHAR(255) NOT NULL,
        profile_url TEXT NOT NULL,
        verification_status VARCHAR(50) DEFAULT 'PENDING',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, platform)
      );

      CREATE TABLE IF NOT EXISTS certificates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        issuer VARCHAR(255) NOT NULL,
        e_class VARCHAR(50) NOT NULL,
        verification_hash VARCHAR(255) UNIQUE NOT NULL,
        issued_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE users ADD COLUMN IF NOT EXISTS magic_token_hash VARCHAR(255);
    `);
    console.log('✅ Database schema verified');
  } catch (err) {
    console.error('❌ DB Auto-Migration Error:', err.message);
  }
}
initDb();

const INVALID_PATHS = ['me', 'dashboard', 'settings', 'login', 'signup', 'explore', 'notifications', 'home', 'feed', 'watch', 'reels', 'p', 'stories'];

function parseSocialLink(urlStr) {
  let url;
  try {
    url = new URL(urlStr.startsWith('http') ? urlStr : `https://${urlStr}`);
  } catch (e) {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const pathSegments = url.pathname.split('/').filter(Boolean);

  if (pathSegments.length === 0 || INVALID_PATHS.includes(pathSegments[0].toLowerCase())) {
    return null;
  }

  if (host.includes('linkedin.com')) {
    if (pathSegments[0] === 'in' && pathSegments[1]) {
      return { platform: 'LinkedIn', handle: pathSegments[1], url: url.href };
    }
    return { platform: 'LinkedIn', handle: pathSegments[0], url: url.href };
  } else if (host.includes('github.com')) {
    return { platform: 'GitHub', handle: pathSegments[0], url: url.href };
  } else if (host.includes('twitter.com') || host.includes('x.com')) {
    return { platform: 'Twitter/X', handle: pathSegments[0], url: url.href };
  } else if (host.includes('leetcode.com')) {
    const handle = pathSegments[0] === 'u' ? pathSegments[1] : pathSegments[0];
    return { platform: 'LeetCode', handle: handle || pathSegments[0], url: url.href };
  } else if (host.includes('codeforces.com')) {
    const handle = pathSegments[0] === 'profile' ? pathSegments[1] : pathSegments[0];
    return { platform: 'Codeforces', handle: handle || pathSegments[0], url: url.href };
  } else if (host.includes('kaggle.com')) {
    return { platform: 'Kaggle', handle: pathSegments[0], url: url.href };
  } else if (host.includes('youtube.com') || host.includes('youtu.be')) {
    let handle = pathSegments[0];
    if (['c', 'channel', 'user', '@'].includes(handle.toLowerCase()) && pathSegments[1]) {
      handle = pathSegments[1];
    }
    return { platform: 'YouTube', handle: handle.replace('@', ''), url: url.href };
  }

  const domain = host.replace('www.', '').split('.')[0];
  const capitalizedPlatform = domain.charAt(0).toUpperCase() + domain.slice(1);
  return { platform: capitalizedPlatform || 'Web Identity', handle: pathSegments[0], url: url.href };
}

// Deep Data Fetchers
async function fetchYouTubeStats(handle) {
  try {
    const cleanHandle = handle.replace('@', '');
    const response = await fetch(`https://pipedapi.kavin.rocks/channel/${cleanHandle}`);
    if (!response.ok) throw new Error('Channel fetch failed');
    const data = await response.json();
    const subs = data.subscribers ? Number(data.subscribers).toLocaleString() : null;
    return subs ? ` (${subs} Subscribers)` : '';
  } catch (err) {
    return '';
  }
}

async function fetchGitHubStats(handle) {
  try {
    const [userRes, reposRes] = await Promise.all([
      fetch(`https://api.github.com/users/${handle}`, { headers: { 'User-Agent': 'ProofOS-App' } }),
      fetch(`https://api.github.com/users/${handle}/repos?per_page=100&sort=updated`, { headers: { 'User-Agent': 'ProofOS-App' } })
    ]);

    if (!userRes.ok) throw new Error('GitHub fetch failed');
    const user = await userRes.json();
    const repos = reposRes.ok ? await reposRes.json() : [];

    const totalStars = Array.isArray(repos) 
      ? repos.reduce((acc, r) => acc + (r.stargazers_count || 0), 0)
      : 0;

    return ` (${user.public_repos || 0} Repos, ${totalStars} Stars, ${user.followers || 0} Followers)`;
  } catch (err) {
    return '';
  }
}

async function fetchLeetCodeStats(handle) {
  try {
    const response = await fetch(`https://leetcode-stats-api.herokuapp.com/${handle}`);
    if (!response.ok) throw new Error('LeetCode fetch failed');
    const data = await response.json();
    if (data.status !== 'success') return '';

    return ` (${data.totalSolved || 0} Solved - ${data.hardSolved || 0} Hard, Rank #${data.ranking?.toLocaleString() || 'N/A'})`;
  } catch (err) {
    return '';
  }
}

async function fetchCodeforcesStats(handle) {
  try {
    const response = await fetch(`https://codeforces.com/api/user.info?handles=${handle}`);
    if (!response.ok) throw new Error('Codeforces fetch failed');
    const data = await response.json();
    if (data.status !== 'OK' || !data.result?.[0]) return '';
    const user = data.result[0];
    return ` (${(user.rank || 'USER').toUpperCase()} - Rating: ${user.rating || 0})`;
  } catch (err) {
    return '';
  }
}

// ----------------------------------------------------
// AUTHENTICATION ROUTES
// ----------------------------------------------------

// Send Magic Link
app.post('/api/auth/magic-link', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, error: 'Email is required.' });

  try {
    let userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    let user = userResult.rows[0];

    if (!user) {
      const newUser = await pool.query(
        'INSERT INTO users (email, identity_trust_level) VALUES ($1, $2) RETURNING *',
        [email, 'LEVEL_1']
      );
      user = newUser.rows[0];
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '15m' });
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    
    await pool.query('UPDATE users SET magic_token_hash = $1 WHERE id = $2', [tokenHash, user.id]);

    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const baseUrl = process.env.APP_URL || `${protocol}://${host}`;
    const magicLink = `${baseUrl}/api/auth/verify-magic?token=${token}`;

    if (process.env.SMTP_USER) {
      await transporter.sendMail({
        from: '"Proof OS" <onboarding@resend.dev>',
        to: email,
        subject: '🔐 Your Proof OS Dashboard Magic Link',
        html: `
          <div style="font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 20px; border-radius: 8px;">
            <h2>Log in to Proof OS</h2>
            <p>Click the button below to log in to your certificate dashboard. This link expires in 15 minutes.</p>
            <a href="${magicLink}" style="background: #22c55e; color: #000; padding: 10px 20px; text-decoration: none; font-weight: bold; border-radius: 6px; display: inline-block; margin-top: 10px;">Log In to Dashboard</a>
          </div>
        `
      });
      return res.json({ success: true, message: 'Magic link sent! Check your email inbox.' });
    } else {
      return res.json({ success: true, message: 'Development Mode: Click link below.', magicLink });
    }
  } catch (err) {
    console.error('Magic link error:', err);
    return res.status(500).json({ success: false, error: 'Failed to generate magic link: ' + err.message });
  }
});

// Verify Magic Link
app.get('/api/auth/verify-magic', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('❌ Missing token.');

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const userResult = await pool.query(
      'SELECT * FROM users WHERE id = $1 AND magic_token_hash = $2', 
      [decoded.userId, tokenHash]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).send('❌ Magic link has already been used or expired.');
    }

    await pool.query('UPDATE users SET magic_token_hash = NULL WHERE id = $1', [decoded.userId]);

    const sessionToken = jwt.sign({ userId: decoded.userId, email: decoded.email }, JWT_SECRET, { expiresIn: '7d' });
    return res.redirect(`/?auth_token=${sessionToken}`);
  } catch (err) {
    return res.status(401).send(`❌ Invalid or expired token: ${err.message}`);
  }
});

// Fetch Protected User Certificates
app.get('/api/user/certificates', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.split(' ')[1] : null;

  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized.' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const certs = await pool.query(
      'SELECT * FROM certificates WHERE user_id = $1 ORDER BY issued_at DESC', 
      [decoded.userId]
    );

    return res.json({ success: true, email: decoded.email, certificates: certs.rows });
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired session.' });
  }
});

// ----------------------------------------------------
// CORE ENGINE & RECRUITER VERIFICATION ROUTES
// ----------------------------------------------------

app.post('/api/verify-account', verificationLimiter, async (req, res) => {
  const { email, profileUrl } = req.body;
  if (!email || !profileUrl) return res.status(400).json({ success: false, error: 'Email and Profile URL required.' });

  const parsed = parseSocialLink(profileUrl);
  if (!parsed) return res.status(400).json({ success: false, error: 'Invalid public profile link.' });

  try {
    let userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    let user = userResult.rows[0];

    if (!user) {
      const newUser = await pool.query(
        'INSERT INTO users (email, identity_trust_level) VALUES ($1, $2) RETURNING *',
        [email, 'LEVEL_2']
      );
      user = newUser.rows[0];
    }

    await pool.query(
      `INSERT INTO social_accounts (user_id, platform, account_handle, profile_url, verification_status)
       VALUES ($1, $2, $3, $4, 'VERIFIED')
       ON CONFLICT (user_id, platform) 
       DO UPDATE SET account_handle = $3, profile_url = $4, verification_status = 'VERIFIED'`,
      [user.id, parsed.platform, parsed.handle, parsed.url]
    );

    let activityStats = '';
    if (parsed.platform === 'YouTube') activityStats = await fetchYouTubeStats(parsed.handle);
    else if (parsed.platform === 'GitHub') activityStats = await fetchGitHubStats(parsed.handle);
    else if (parsed.platform === 'LeetCode') activityStats = await fetchLeetCodeStats(parsed.handle);
    else if (parsed.platform === 'Codeforces') activityStats = await fetchCodeforcesStats(parsed.handle);

    const title = `Verified ${parsed.platform} Work Identity (@${parsed.handle}${activityStats})`;
    const hashData = `${user.id}:${parsed.platform}:${parsed.handle}:${Date.now()}`;
    const verificationHash = '0x' + crypto.createHash('sha256').update(hashData).digest('hex');

    const certResult = await pool.query(
      `INSERT INTO certificates (user_id, title, issuer, e_class, verification_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [user.id, title, 'Proof of Opportunity Engine', 'CLASS_A', verificationHash]
    );

    const cert = certResult.rows[0];

    return res.json({
      success: true,
      user: { id: user.id, email: user.email },
      platformData: parsed,
      certificate: {
        id: cert.id,
        title: cert.title,
        issuer: cert.issuer,
        eClass: cert.e_class,
        verificationHash: cert.verification_hash,
        issuedAt: cert.issued_at
      }
    });
  } catch (err) {
    console.error('Database Verification Error:', err);
    return res.status(500).json({ success: false, error: 'Database execution error: ' + err.message });
  }
});

// Dynamic SVG Badge Route
app.get('/badge/:param.svg', async (req, res) => {
  const { param } = req.params;

  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(param);
    let queryText = `
      SELECT c.*, u.email
      FROM certificates c
      JOIN users u ON c.user_id = u.id
      WHERE `;
    queryText += isUuid ? `c.id = $1` : `c.verification_hash = $1`;

    const result = await pool.query(queryText, [param]);

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'max-age=3600, s-maxage=3600, public');

    if (result.rows.length === 0) {
      const errorSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="220" height="28" role="img" aria-label="Proof OS: Unverified">
          <linearGradient id="b" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
          <clipPath id="a"><rect width="220" height="28" rx="4" fill="#fff"/></clipPath>
          <g clip-path="url(#a)">
            <rect width="80" height="28" fill="#334155"/>
            <rect x="80" width="140" height="28" fill="#ef4444"/>
            <rect width="220" height="28" fill="url(#b)"/>
          </g>
          <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
            <text x="40" y="18" fill="#010101" fill-opacity=".3">Proof OS</text>
            <text x="40" y="17">Proof OS</text>
            <text x="150" y="18" fill="#010101" fill-opacity=".3">UNVERIFIED</text>
            <text x="150" y="17" font-weight="bold">UNVERIFIED</text>
          </g>
        </svg>
      `.trim();
      return res.send(errorSvg);
    }

    const cert = result.rows[0];
    const badgeLabel = cert.title.split('(')[0].trim();
    
    const leftText = "Proof OS";
    const rightText = `✓ ${badgeLabel}`;
    const leftWidth = 75;
    const rightWidth = Math.max(130, rightText.length * 7.5);
    const totalWidth = leftWidth + rightWidth;

    const badgeSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="28" role="img" aria-label="${leftText}: ${rightText}">
        <linearGradient id="b" x2="0" y2="100%">
          <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
          <stop offset="1" stop-opacity=".1"/>
        </linearGradient>
        <clipPath id="a">
          <rect width="${totalWidth}" height="28" rx="5" fill="#fff"/>
        </clipPath>
        <g clip-path="url(#a)">
          <rect width="${leftWidth}" height="28" fill="#0f172a"/>
          <rect x="${leftWidth}" width="${rightWidth}" height="28" fill="#15803d"/>
          <rect width="${totalWidth}" height="28" fill="url(#b)"/>
        </g>
        <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
          <text x="${leftWidth / 2}" y="18" fill="#010101" fill-opacity=".3">${leftText}</text>
          <text x="${leftWidth / 2}" y="17" font-weight="bold">${leftText}</text>
          <text x="${leftWidth + rightWidth / 2}" y="18" fill="#010101" fill-opacity=".3">${rightText}</text>
          <text x="${leftWidth + rightWidth / 2}" y="17" font-weight="bold">${rightText}</text>
        </g>
      </svg>
    `.trim();

    return res.send(badgeSvg);

  } catch (err) {
    console.error('Badge generation error:', err);
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.status(500).send(`
      <svg xmlns="http://www.w3.org/2000/svg" width="120" height="28">
        <rect width="120" height="28" fill="#ef4444" rx="4"/>
        <text x="60" y="18" fill="#fff" font-size="11" text-anchor="middle" font-family="sans-serif">ERROR</text>
      </svg>
    `);
  }
});

// HTML Public Recruiter Verification View
app.get('/verify/:param', async (req, res) => {
  const { param } = req.params;
  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(param);
    let queryText = `
      SELECT c.*, u.email as recipient_email
      FROM certificates c
      JOIN users u ON c.user_id = u.id
      WHERE `;
    queryText += isUuid ? `c.id = $1` : `c.verification_hash = $1`;

    const result = await pool.query(queryText, [param]);

    if (result.rows.length === 0) {
      return res.status(404).send(`
        <!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Not Found</title></head>
        <body style="background:#0f172a;color:#f87171;font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;">
          <div style="text-align:center;"><h2>❌ Certificate Not Found</h2><p style="color:#94a3b8;">The requested ledger record does not exist.</p></div>
        </body></html>
      `);
    }

    const c = result.rows[0];

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Recruiter Proof Record | Proof OS</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { background: #0f172a; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
          .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 28px; max-width: 550px; width: 100%; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
          .badge { background: #22c55e; color: #000; font-weight: bold; padding: 6px 12px; border-radius: 20px; display: inline-block; font-size: 0.75rem; letter-spacing: 0.05em; margin-bottom: 15px; }
          h2 { margin: 0 0 8px 0; color: #f8fafc; font-size: 1.4rem; }
          .subtitle { color: #38bdf8; font-weight: 600; margin-bottom: 20px; }
          .meta { background: #090d16; padding: 14px; border-radius: 8px; font-size: 0.85rem; color: #cbd5e1; border: 1px solid #1e293b; }
          .meta p { margin: 6px 0; }
          .hash { font-family: monospace; font-size: 0.7rem; word-break: break-all; color: #64748b; margin-top: 15px; }
          .btn-print { display: block; width: 100%; text-align: center; margin-top: 20px; background: #38bdf8; color: #0f172a; font-weight: bold; padding: 10px; border-radius: 6px; text-decoration: none; cursor: pointer; border: none; }
        </style>
      </head>
      <body>
        <div class="card">
          <span class="badge">✓ OFFICIAL VERIFIED AUDIT</span>
          <h2>${c.title}</h2>
          <div class="subtitle">Proof of Technical Capability & Identity</div>

          <div class="meta">
            <p><strong>Candidate:</strong> ${c.recipient_email}</p>
            <p><strong>Audit Engine:</strong> ${c.issuer}</p>
            <p><strong>Trust Tier:</strong> ${c.e_class} (Cryptographically Signed)</p>
            <p><strong>Verified On:</strong> ${new Date(c.issued_at).toLocaleDateString()}</p>
          </div>

          <button onclick="window.print()" class="btn-print">🖨️ Save as PDF Proof</button>
          <div class="hash"><strong>Ledger Hash:</strong> ${c.verification_hash}</div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

// Single Page Application Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`Proof OS Server listening on port ${PORT}`));
}

module.exports = app;

