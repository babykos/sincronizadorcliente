const fs   = require('fs');
const path = require('path');

// TODO lo configurable en runtime: credenciales de la BD local + URL/api_key del
// servidor. Se edita SOLO desde el panel (:3010) y se persiste en state/ajustes.json.

const DIR     = path.join(__dirname, '..', 'state');
const ARCHIVO = path.join(DIR, 'ajustes.json');

let mem = null;

const normUrl = u => (u || '').trim().replace(/\/+$/, '');

function base() {
  return {
    db: { host: '', port: 3306, user: '', password: '', database: '' },
    servidorUrl: '',
    apiKey: '',
    mysqldumpRuta: ''   // vacío = autodetectar (ver lib/respaldo.js)
  };
}

function cargar() {
  let guardado = null;
  try { guardado = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')); } catch { /* aún no existe */ }
  const b = base();
  mem = guardado ? {
    db:          { ...b.db, ...(guardado.db || {}) },
    servidorUrl: normUrl(guardado.servidorUrl),
    apiKey:      (guardado.apiKey || '').trim(),
    mysqldumpRuta: (guardado.mysqldumpRuta || '').trim()
  } : b;
  return mem;
}

function get() { return mem || cargar(); }

// Guarda un parcial. Contraseña/api_key vacías NO borran las guardadas.
function guardar(parcial = {}) {
  const a  = get();
  const pd = parcial.db || {};
  mem = {
    db: {
      host:     pd.host     !== undefined ? String(pd.host).trim()          : a.db.host,
      port:     pd.port     !== undefined ? (parseInt(pd.port, 10) || 3306) : a.db.port,
      user:     pd.user     !== undefined ? String(pd.user).trim()          : a.db.user,
      password: (pd.password !== undefined && pd.password !== '')           ? String(pd.password) : a.db.password,
      database: pd.database !== undefined ? String(pd.database).trim()      : a.db.database
    },
    servidorUrl: parcial.servidorUrl !== undefined ? normUrl(parcial.servidorUrl) : a.servidorUrl,
    apiKey:      (parcial.apiKey !== undefined && parcial.apiKey !== '')     ? String(parcial.apiKey).trim() : a.apiKey,
    mysqldumpRuta: parcial.mysqldumpRuta !== undefined ? String(parcial.mysqldumpRuta).trim() : (a.mysqldumpRuta || '')
  };
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = ARCHIVO + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(mem, null, 2));
  fs.renameSync(tmp, ARCHIVO);
  return mem;
}

function servidorConfigurado() {
  const a = get();
  return Boolean(a.servidorUrl && a.apiKey);
}

module.exports = { cargar, get, guardar, servidorConfigurado };
