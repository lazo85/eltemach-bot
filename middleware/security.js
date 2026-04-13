/**
 * TemaichBot — Security Middleware
 * Protecciones: rate limiting, headers, sanitización, detección de ataques, logging
 */

const fs   = require('fs');
const path = require('path');

// ── Log de seguridad ─────────────────────────────────────────────────────────
const LOG_DIR  = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'security.log');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function secLog(level, event, data = {}) {
  const entry = JSON.stringify({
    ts: new Date().toISOString(), level, event, ...data
  });
  fs.appendFile(LOG_FILE, entry + '\n', () => {});
  if (level === 'WARN' || level === 'BLOCK') {
    console.warn(`[Security][${level}] ${event}`, data.ip || '');
  }
}

// ── Rate limiter en memoria ──────────────────────────────────────────────────
// Estructura: Map<ip, { count, windowStart, blocked, blockUntil }>
const rateLimitStore = new Map();

// IPs locales exentas de rate limiting
const RATE_LIMIT_WHITELIST = ['::1', '127.0.0.1', '::ffff:127.0.0.1'];

// Limpiar entradas viejas cada 5 minutos
setInterval(() => {
  const now = Date.now();
  for (const [ip, state] of rateLimitStore) {
    if (now - state.windowStart > 10 * 60 * 1000) rateLimitStore.delete(ip);
  }
}, 5 * 60 * 1000);

/**
 * Crea un middleware de rate limiting
 * @param {object} opts
 *   windowMs  — duración de la ventana en ms
 *   max       — máx requests por ventana
 *   blockMs   — cuánto bloquear cuando se supera el límite
 *   message   — mensaje de error
 */
function rateLimit({ windowMs = 60_000, max = 60, blockMs = 5 * 60_000, message = 'Demasiadas solicitudes, intenta más tarde.' } = {}) {
  return (req, res, next) => {
    const ip  = getIp(req);
    if (RATE_LIMIT_WHITELIST.includes(ip)) return next();
    const now = Date.now();
    let state = rateLimitStore.get(ip);

    // IP bloqueada
    if (state?.blocked && now < state.blockUntil) {
      secLog('BLOCK', 'rate_limit_blocked', { ip, path: req.path });
      return res.status(429).json({ error: message });
    }

    // Reiniciar ventana si expiró
    if (!state || now - state.windowStart > windowMs) {
      state = { count: 0, windowStart: now, blocked: false, blockUntil: 0 };
    }

    state.count++;

    if (state.count > max) {
      state.blocked   = true;
      state.blockUntil = now + blockMs;
      rateLimitStore.set(ip, state);
      secLog('WARN', 'rate_limit_exceeded', { ip, path: req.path, count: state.count });
      return res.status(429).json({ error: message });
    }

    rateLimitStore.set(ip, state);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - state.count));
    next();
  };
}

// ── IP helper ────────────────────────────────────────────────────────────────
function getIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

// ── Security headers ─────────────────────────────────────────────────────────
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options',    'nosniff');
  res.setHeader('X-Frame-Options',           'DENY');
  res.setHeader('X-XSS-Protection',          '1; mode=block');
  res.setHeader('Referrer-Policy',           'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy',        'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://accounts.google.com https://apis.google.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: https:; " +
    "connect-src 'self' https://accounts.google.com; " +
    "frame-src https://accounts.google.com;"
  );
  // Eliminar header que revela tecnología
  res.removeHeader('X-Powered-By');
  next();
}

// ── Sanitización de inputs ────────────────────────────────────────────────────
// Previene XSS básico y payloads sospechosos en body/query
const SUSPICIOUS_PATTERNS = [
  /<script[\s\S]*?>[\s\S]*?<\/script>/gi,
  /javascript\s*:/gi,
  /on\w+\s*=/gi,          // onclick=, onerror=, etc.
  /union\s+select/gi,     // SQL injection
  /;\s*drop\s+table/gi,
  /;\s*delete\s+from/gi,
  /--\s*$/gm,             // SQL comment
  /\/\*[\s\S]*?\*\//g,    // SQL block comment
  /\x00/g,                // null bytes
];

function sanitizeValue(val) {
  if (typeof val !== 'string') return val;
  // Strip null bytes
  val = val.replace(/\x00/g, '');
  // Truncar strings muy largos (posible DoS)
  if (val.length > 10_000) val = val.slice(0, 10_000);
  return val;
}

function detectAttack(val, path, ip) {
  if (typeof val !== 'string') return false;
  for (const pattern of SUSPICIOUS_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(val)) {
      secLog('WARN', 'suspicious_input', { ip, path, pattern: pattern.toString().slice(0, 40) });
      return true;
    }
  }
  return false;
}

function sanitizeBody(req, res, next) {
  const ip = getIp(req);

  const checkObj = (obj, depth = 0) => {
    if (depth > 5 || !obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'string') {
        if (detectAttack(obj[key], req.path, ip)) {
          return res.status(400).json({ error: 'Solicitud inválida' });
        }
        obj[key] = sanitizeValue(obj[key]);
      } else if (typeof obj[key] === 'object') {
        checkObj(obj[key], depth + 1);
      }
    }
  };

  if (req.body)  checkObj(req.body);
  if (req.query) checkObj(req.query);
  next();
}

// ── Detección de user agents sospechosos ─────────────────────────────────────
const BAD_UA_PATTERNS = [
  /sqlmap/i, /nikto/i, /nmap/i, /masscan/i,
  /zgrab/i, /dirbuster/i, /gobuster/i, /wfuzz/i,
  /burpsuite/i, /hydra/i, /metasploit/i,
];

function detectScanners(req, res, next) {
  const ua = req.headers['user-agent'] || '';
  if (BAD_UA_PATTERNS.some(p => p.test(ua))) {
    secLog('BLOCK', 'scanner_detected', { ip: getIp(req), ua: ua.slice(0, 100), path: req.path });
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  next();
}

// ── Bloqueo de rutas sensibles ────────────────────────────────────────────────
const BLOCKED_PATHS = [
  /\/\.env/i, /\/\.git/i, /\/\.ssh/i,
  /\/wp-admin/i, /\/phpmy/i, /\/adminer/i,
  /\/etc\/passwd/i, /\/proc\//i,
  /\.(php|asp|aspx|jsp|cgi|sh|bash)$/i,
];

function blockSensitivePaths(req, res, next) {
  if (BLOCKED_PATHS.some(p => p.test(req.path))) {
    secLog('BLOCK', 'sensitive_path', { ip: getIp(req), path: req.path });
    return res.status(404).end();
  }
  next();
}

// ── Content-Type enforcement para APIs ───────────────────────────────────────
function requireJson(req, res, next) {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('application/json')) {
      return res.status(415).json({ error: 'Content-Type debe ser application/json' });
    }
  }
  next();
}

// ── Límites de tamaño de payload ─────────────────────────────────────────────
function limitPayloadSize(maxKb = 100) {
  return (req, res, next) => {
    const cl = parseInt(req.headers['content-length'] || '0');
    if (cl > maxKb * 1024) {
      secLog('WARN', 'payload_too_large', { ip: getIp(req), path: req.path, size: cl });
      return res.status(413).json({ error: 'Payload demasiado grande' });
    }
    next();
  };
}

// ── Rate limits específicos por ruta ─────────────────────────────────────────
const limits = {
  // Auth: máx 5 intentos por 15 min, bloqueo 5 min si se pasa
  auth: rateLimit({ windowMs: 15 * 60_000, max: 5, blockMs: 5 * 60_000,
    message: 'Demasiados intentos de autenticación. Espera 5 minutos.' }),

  // Chat: máx 30 mensajes por minuto
  chat: rateLimit({ windowMs: 60_000, max: 30, blockMs: 2 * 60_000,
    message: 'Demasiados mensajes. Espera un momento.' }),

  // API general: 120 req/min
  api: rateLimit({ windowMs: 60_000, max: 120, blockMs: 5 * 60_000,
    message: 'Límite de API alcanzado.' }),

  // Admin: 60 req/min
  admin: rateLimit({ windowMs: 60_000, max: 60, blockMs: 5 * 60_000,
    message: 'Límite de administración alcanzado.' }),
};

// ── Endpoint de estado de seguridad (solo admin) ──────────────────────────────
function securityStats(req, res) {
  const blocked  = [...rateLimitStore.entries()]
    .filter(([, s]) => s.blocked && Date.now() < s.blockUntil)
    .map(([ip, s]) => ({ ip, until: new Date(s.blockUntil).toISOString() }));

  const logLines = fs.existsSync(LOG_FILE)
    ? fs.readFileSync(LOG_FILE, 'utf-8').trim().split('\n').slice(-50).reverse()
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];

  res.json({
    blockedIPs: blocked,
    recentEvents: logLines,
    rateLimitStore: rateLimitStore.size
  });
}

module.exports = {
  securityHeaders,
  sanitizeBody,
  detectScanners,
  blockSensitivePaths,
  requireJson,
  limitPayloadSize,
  limits,
  securityStats,
  secLog,
  getIp,
};
