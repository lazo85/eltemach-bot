const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const https = require('https');
const { getDb } = require('../database/db');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth');

const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/auth/google/callback';

function googleAuthUrl() {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account'
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function httpsPost(url, data) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();
    const u = new URL(url);
    const options = {
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}


// GET /api/auth/check-email?email=xxx
router.get('/check-email', (req, res) => {
  const { email } = req.query;
  if (!email) return res.json({ available: false });
  const exists = getDb().prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  res.json({ available: !exists });
});

// POST /api/auth/register
router.post('/register', (req, res) => {
  const { email, username, password } = req.body;

  if (!email || !username || !password)
    return res.status(400).json({ error: 'Todos los campos son requeridos' });

  if (password.length < 6)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
  if (existing)
    return res.status(409).json({ error: 'El email o nombre de usuario ya está registrado' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(
    'INSERT INTO users (email, username, password_hash, tokens) VALUES (?, ?, ?, 3)'
  ).run(email.toLowerCase().trim(), username.trim(), hash);

  // Registrar bono de bienvenida
  db.prepare(
    'INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)'
  ).run(result.lastInsertRowid, 'register_bonus', 3, 'Bono de bienvenida — 3 tokens gratuitos');

  const token = jwt.sign({ userId: result.lastInsertRowid }, JWT_SECRET, { expiresIn: '7d' });
  res.status(201).json({
    token,
    user: { id: result.lastInsertRowid, email, username, tokens: 3, is_admin: 0 }
  });
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email y contraseña requeridos' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Credenciales incorrectas' });

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({
    token,
    user: { id: user.id, email: user.email, username: user.username, tokens: user.tokens, is_admin: user.is_admin }
  });
});

// GET /api/auth/config
router.get('/config', (req, res) => {
  res.json({ googleEnabled: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) });
});

// GET /api/auth/google — inicia el flujo OAuth
router.get('/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)
    return res.status(503).send('Google OAuth no configurado');
  res.redirect(googleAuthUrl());
});

// GET /auth/google/callback — Google redirige aquí con el código
router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/login?error=google_denied');

  try {
    // Intercambiar código por tokens
    const tokens = await httpsPost('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    });

    if (!tokens.access_token) throw new Error('No access token received');

    // Obtener info del usuario
    const profile = await httpsGet('https://www.googleapis.com/oauth2/v2/userinfo', tokens.access_token);
    const { id: googleId, email, name } = profile;

    const db = getDb();
    let user = db.prepare('SELECT * FROM users WHERE google_id = ? OR email = ?').get(googleId, email);

    if (!user) {
      let base = (name || email.split('@')[0]).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || 'user';
      let username = base;
      let i = 1;
      while (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
        username = `${base}_${i++}`;
      }
      const result = db.prepare(
        'INSERT INTO users (email, username, password_hash, tokens, google_id) VALUES (?, ?, ?, 3, ?)'
      ).run(email, username, '', googleId);

      db.prepare(
        'INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)'
      ).run(result.lastInsertRowid, 'register_bonus', 3, 'Bono de bienvenida — 3 tokens gratuitos');

      user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    } else if (!user.google_id) {
      db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(googleId, user.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

    // Redirigir al frontend con el token en la URL
    res.redirect(`/login?token=${token}&user=${encodeURIComponent(JSON.stringify({
      id: user.id, email: user.email, username: user.username, tokens: user.tokens, is_admin: user.is_admin
    }))}`);
  } catch (err) {
    console.error('[Google Callback] ERROR:', err.message);
    res.redirect(`/login?error=${encodeURIComponent(err.message)}`);
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, (req, res) => {
  const db = getDb();
  const transactions = db.prepare(
    'SELECT type, amount, description, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20'
  ).all(req.user.id);

  res.json({ ...req.user, transactions });
});

module.exports = router;
