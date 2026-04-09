// Carga .env manualmente para evitar conflictos con dotenvx
const fs = require('fs');
const envPath = require('path').join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const [key, ...vals] = line.split('=');
    if (key && key.trim() && !key.startsWith('#')) {
      process.env[key.trim()] = vals.join('=').trim();
    }
  });
}
const express = require('express');
const path = require('path');
const { init } = require('./database/db');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API routes
const authRouter = require('./routes/auth');
app.use('/api/auth',   authRouter);
app.use('/auth',       authRouter);  // para /auth/google y /auth/google/callback
app.use('/api/bot',    require('./routes/bot'));
app.use('/api/tokens',   require('./routes/tokens'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/admin',    require('./routes/admin'));

// Page routes
app.get('/',          (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));
app.get('/login',     (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.get('/register',  (req, res) => res.sendFile(path.join(__dirname, 'views', 'register.html')));
app.get('/profile',   (req, res) => res.sendFile(path.join(__dirname, 'views', 'profile.html')));
app.get('/admin',           (req, res) => res.sendFile(path.join(__dirname, 'views', 'admin.html')));
app.get('/payment/success', (req, res) => res.sendFile(path.join(__dirname, 'views', 'payment-result.html')));
app.get('/payment/failure', (req, res) => res.sendFile(path.join(__dirname, 'views', 'payment-result.html')));
app.get('/payment/pending', (req, res) => res.sendFile(path.join(__dirname, 'views', 'payment-result.html')));

init();

app.listen(PORT, () => {
  console.log(`\n  ElTemAIch corriendo en: http://localhost:${PORT}\n`);
});
