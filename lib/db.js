const mysql   = require('mysql2/promise');
const ajustes = require('./ajustes');

// Pool DINÁMICO a la BD local. Se crea la primera vez que se pide y se puede
// recrear cuando cambian las credenciales desde el panel.

let pool = null;

function crear() {
  const { db } = ajustes.get();
  return mysql.createPool({
    host:     db.host,
    port:     db.port,
    user:     db.user,
    password: db.password,
    database: db.database,
    charset:  'utf8mb4',
    dateStrings: true,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0
  });
}

function configurada() {
  const { db } = ajustes.get();
  return Boolean(db.host && db.user && db.database);
}

function getPool() {
  if (!pool) pool = crear();
  return pool;
}

async function recrear() {
  const viejo = pool;
  pool = null;
  if (viejo) { try { await viejo.end(); } catch { /* ignore */ } }
  return getPool();
}

async function cerrar() {
  if (pool) { try { await pool.end(); } catch { /* ignore */ } pool = null; }
}

// Prueba una configuración SIN tocar el pool vivo (para el botón "Probar BD").
async function probar(dbConf) {
  let conn;
  try {
    conn = await mysql.createConnection({
      host:     dbConf.host,
      port:     parseInt(dbConf.port, 10) || 3306,
      user:     dbConf.user,
      password: dbConf.password,
      database: dbConf.database,
      connectTimeout: 8000
    });
    await conn.query('SELECT 1');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (conn) { try { await conn.end(); } catch { /* ignore */ } }
  }
}

module.exports = { getPool, recrear, cerrar, probar, configurada };
