const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'temach.db');
let db;

function init() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT UNIQUE NOT NULL,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL DEFAULT '',
      tokens        INTEGER DEFAULT 3,
      is_admin      INTEGER DEFAULT 0,
      google_id     TEXT UNIQUE,
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      type        TEXT NOT NULL,
      amount      INTEGER NOT NULL,
      description TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS purchase_requests (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      package_id  TEXT NOT NULL,
      tokens      INTEGER NOT NULL,
      price_usd   REAL NOT NULL,
      status      TEXT DEFAULT 'pending',
      created_at  TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // Migración: agregar google_id si no existe (DB creada antes)
  try { db.exec('ALTER TABLE users ADD COLUMN google_id TEXT UNIQUE'); } catch (_) {}

  // Crear admin si no existe
  const admin = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@eltemach.com');
  if (!admin) {
    const hash = bcrypt.hashSync('TemAIch2024!', 10);
    db.prepare(
      'INSERT INTO users (email, username, password_hash, tokens, is_admin) VALUES (?, ?, ?, ?, ?)'
    ).run('admin@eltemach.com', 'admin', hash, 999999, 1);
    console.log('  [DB] Cuenta admin creada → admin@eltemach.com / TemAIch2024!');
  }

  console.log('  [DB] Base de datos lista');
  return db;
}

function getDb() {
  if (!db) init();
  return db;
}

module.exports = { init, getDb };
