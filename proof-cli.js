#!/usr/bin/env node

const BASE_URL = 'http://localhost:3000/api';
const API_KEY = 'proof_os_secret_key_2026';

const headers = {
  'Content-Type': 'application/json',
  'x-api-key': API_KEY
};

async function main() {
  const [,, command, ...args] = process.argv;

  switch (command) {
    case 'register': {
      const email = args[0];
      if (!email) return console.log('❌ Usage: node proof-cli.js register <email>');
      
      const res = await fetch(`${BASE_URL}/users`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, identityTrustLevel: 'LEVEL_1' })
      });
      const data = await res.json();
      console.log('✅ User Registered:', data);
      break;
    }

    case 'submit-evidence': {
      const [userId, title, eClass, sourceUri] = args;
      if (!userId || !title || !eClass || !sourceUri) {
        return console.log('❌ Usage: node proof-cli.js submit-evidence <userId> <title> <eClass> <sourceUri>');
      }

      const res = await fetch(`${BASE_URL}/evidence`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ userId, title, eClass, sourceUri, aiConfidenceScore: 0.95 })
      });
      const data = await res.json();
      console.log('✅ Evidence Submitted & Verified:', data);
      break;
    }

    case 'attach-vector': {
      const [artifactId, ...vectorArgs] = args;
      if (!artifactId || vectorArgs.length === 0) {
        return console.log('❌ Usage: node proof-cli.js attach-vector <artifactId> <v1> <v2> <v3>');
      }
      const embedding = vectorArgs.map(Number);

      const res = await fetch(`${BASE_URL}/evidence/embedding`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ artifactId, embedding })
      });
      const data = await res.json();
      console.log('✅ Vector Attached:', data);
      break;
    }

    case 'match': {
      if (args.length === 0) {
        return console.log('❌ Usage: node proof-cli.js match <v1> <v2> <v3>');
      }
      const queryVector = args.map(Number);

      const res = await fetch(`${BASE_URL}/match`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ queryVector, matchThreshold: 0.7 })
      });
      const data = await res.json();
      console.log('🎯 Match Search Results:', JSON.stringify(data, null, 2));
      break;
    }

    case 'simulate-github': {
      const [email, prTitle, prUrl] = args;
      if (!email || !prTitle || !prUrl) {
        return console.log('❌ Usage: node proof-cli.js simulate-github <email> <prTitle> <prUrl>');
      }

      const mockPayload = {
        action: 'closed',
        pull_request: {
          number: Math.floor(Math.random() * 100) + 1,
          title: prTitle,
          merged: true,
          html_url: prUrl,
          body: 'Automated verification via Proof OS Webhook Integration.'
        },
        sender: { login: email.split('@')[0], email }
      };

      const res = await fetch(`${BASE_URL}/webhooks/github`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mockPayload)
      });
      const data = await res.json();
      console.log('⚡ Webhook Processed:', data);
      break;
    }

    case 'aggregate': {
      const userId = args[0];
      if (!userId) return console.log('❌ Usage: node proof-cli.js aggregate <userId>');

      const res = await fetch(`${BASE_URL}/users/aggregate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ userId })
      });
      const data = await res.json();
      console.log('📊 Profile Aggregated & Saved to DB:', JSON.stringify(data, null, 2));
      break;
    }

    case 'badge': {
      const userId = args[0];
      if (!userId) return console.log('❌ Usage: node proof-cli.js badge <userId>');

      const res = await fetch(`${BASE_URL}/users/${userId}/badge`);
      const data = await res.json();
      console.log('🛡️ Verified Proof Badge:', JSON.stringify(data, null, 2));
      break;
    }

    default:
      console.log(`
🚀 Proof OS CLI Tool

Available Commands:
  node proof-cli.js register <email>
  node proof-cli.js submit-evidence <userId> <title> <eClass> <sourceUri>
  node proof-cli.js attach-vector <artifactId> <v1> <v2> <v3>
  node proof-cli.js match <v1> <v2> <v3>
  node proof-cli.js simulate-github <email> <prTitle> <prUrl>
  node proof-cli.js aggregate <userId>
  node proof-cli.js badge <userId>
      `);
  }
}

main().catch(err => console.error('Error:', err.message));
