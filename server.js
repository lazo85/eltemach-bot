// Carga .env solo en local, sin sobreescribir variables de entorno ya definidas (ej: Render)
const fs   = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const [key, ...vals] = line.split('=');
    if (key && key.trim() && !key.startsWith('#') && !process.env[key.trim()]) {
      process.env[key.trim()] = vals.join('=').trim();
    }
  });
}

const express = require('express');
const { init } = require('./database/db');
const {
  securityHeaders,
  sanitizeBody,
  detectScanners,
  blockSensitivePaths,
  limitPayloadSize,
  limits,
  securityStats,
} = require('./middleware/security');
const { adminMiddleware } = require('./middleware/auth');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── 1. Seguridad global (primero) ────────────────────────────────────────────
app.use(securityHeaders);
app.use(detectScanners);
app.use(blockSensitivePaths);
app.use(limitPayloadSize(200));       // máx 200 KB por request

// ── 2. Parseo ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '200kb' }));
app.use(sanitizeBody);                // sanitizar después de parsear

// ── 3. Archivos estáticos ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── 4. API routes con rate limits ────────────────────────────────────────────
const authRouter = require('./routes/auth');
app.use('/api/auth', authRouter);
app.use('/auth',     authRouter);   // /auth/google y callback

app.use('/api/bot',      limits.chat,  require('./routes/bot'));
app.use('/api/tokens',   limits.api,   require('./routes/tokens'));
app.use('/api/payments', limits.api,   require('./routes/payments'));
app.use('/api/admin',    limits.admin, require('./routes/admin'));

// ── 5. Endpoint de seguridad (solo admin) ────────────────────────────────────
app.get('/api/admin/security', adminMiddleware, securityStats);

// ── 6. Page routes ───────────────────────────────────────────────────────────
app.get('/',               (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));
app.get('/login',          (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.get('/register',       (req, res) => res.sendFile(path.join(__dirname, 'views', 'register.html')));
app.get('/profile',        (req, res) => res.sendFile(path.join(__dirname, 'views', 'profile.html')));
app.get('/admin',          (req, res) => res.sendFile(path.join(__dirname, 'views', 'admin.html')));
app.get('/payment/success',(req, res) => res.sendFile(path.join(__dirname, 'views', 'payment-result.html')));
app.get('/payment/failure',(req, res) => res.sendFile(path.join(__dirname, 'views', 'payment-result.html')));
app.get('/payment/pending',(req, res) => res.sendFile(path.join(__dirname, 'views', 'payment-result.html')));

// ── 7. 404 catch-all ─────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'views', '404.html')));

// ── 8. Error handler global ──────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.message);
  res.status(500).json({ error: 'Error interno del servidor' });
});

init();

app.listen(PORT, () => {
  console.log(`\n  ElTemAIch corriendo en: http://localhost:${PORT}`);
  console.log(`  Seguridad: headers ✓ | rate-limit ✓ | sanitización ✓ | scanner-detection ✓\n`);
});
