const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const zlib   = require('zlib');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const ajustes = require('./ajustes');
const log     = require('./log');

// Respaldo de la BD local para el servidor: mysqldump -> gzip -> POST /api/respaldo.
// En el servidor queda como "solicitud de actualización" de la maestra; el admin
// la aprueba allá. La fuente de verdad es este nodo.
//
// Tablas propias del nodo que NO viajan (la maestra tiene las suyas):
const EXCLUIR = ['sync_control', 'id_secuencias', 'local'];

const DIR = path.join(__dirname, '..', 'state', 'respaldos');
const EXE = process.platform === 'win32' ? 'mysqldump.exe' : 'mysqldump';

// Estado del último respaldo (lo consulta el panel).
let actual = { fase: 'inactivo' };   // inactivo | volcando | subiendo | listo | error
const ocupado = () => actual.fase === 'volcando' || actual.fase === 'subiendo';

/* ------------------------------ mysqldump ------------------------------ */

function candidatos() {
  const out = [];
  const conf = ajustes.get().mysqldumpRuta;
  if (conf) out.push(fs.existsSync(conf) && fs.statSync(conf).isDirectory() ? path.join(conf, EXE) : conf);

  const w = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['mysqldump'], { encoding: 'utf8' });
  if (w.status === 0) out.push(...w.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean));

  if (process.platform === 'win32') {
    const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\ProgramData'].filter(Boolean);
    const servidor = [], workbench = [];
    for (const b of bases) {
      let dirs = [];
      try { dirs = fs.readdirSync(b).filter(d => /^(MySQL|MariaDB)/i.test(d)); } catch { /* noop */ }
      for (const d of dirs) {
        const raiz = path.join(b, d);
        let subs = [];
        try { subs = fs.readdirSync(raiz); } catch { /* noop */ }
        for (const s of [...subs.map(x => path.join(raiz, x)), raiz]) {
          for (const p of [path.join(s, 'bin', EXE), path.join(s, EXE)]) {
            (/workbench/i.test(p) ? workbench : servidor).push(p);
          }
        }
      }
    }
    out.push(...servidor.sort().reverse(), 'C:\\xampp\\mysql\\bin\\' + EXE, ...workbench.sort().reverse());
  }
  return [...new Set(out)];
}

// Se cachea: --help/--version cuestan; se invalida al cambiar la ruta en el panel.
let detectado;
function detectar({ forzar = false } = {}) {
  if (detectado !== undefined && !forzar) return detectado;
  detectado = buscar();
  return detectado;
}

function buscar() {
  for (const p of candidatos()) {
    if (p !== 'mysqldump' && !fs.existsSync(p)) continue;
    const h = spawnSync(p, ['--help'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (h.error || !h.stdout) continue;
    const version = (spawnSync(p, ['--version'], { encoding: 'utf8' }).stdout || '').trim();
    return {
      ruta: p,
      version,
      columnStats: h.stdout.includes('column-statistics'),
      gtid:        h.stdout.includes('set-gtid-purged')
    };
  }
  return null;
}

// Archivo de opciones temporal: así la contraseña no va en la línea de comandos.
function archivoOpciones(dbc) {
  const q = v => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const ruta = path.join(DIR, `.mysqldump-${process.pid}.cnf`);
  fs.writeFileSync(ruta,
    `[client]\nuser=${q(dbc.user)}\npassword=${q(dbc.password)}\nhost=${q(dbc.host || '127.0.0.1')}\nport=${parseInt(dbc.port, 10) || 3306}\n`,
    { mode: 0o600 });
  return ruta;
}

function volcar(md, dbc, destino) {
  const cnf = archivoOpciones(dbc);
  const args = [
    `--defaults-extra-file=${cnf}`,
    '--single-transaction', '--quick', '--skip-lock-tables',
    '--skip-triggers', '--hex-blob', '--no-tablespaces',
    '--default-character-set=utf8mb4', '--skip-comments',
    ...(md.columnStats ? ['--column-statistics=0'] : []),
    ...(md.gtid ? ['--set-gtid-purged=OFF'] : []),
    ...EXCLUIR.map(t => `--ignore-table=${dbc.database}.${t}`),
    dbc.database
  ];

  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const out  = fs.createWriteStream(destino);
    const gz   = zlib.createGzip({ level: 6 });
    const p    = spawn(md.ruta, args, { windowsHide: true });
    let err = '', codigo = null, escrito = false;
    const fin = () => {
      if (codigo === null || !escrito) return;
      fs.rm(cnf, { force: true }, () => {});
      if (codigo !== 0) return reject(new Error(`mysqldump terminó con código ${codigo}: ${err.trim().slice(0, 800)}`));
      resolve({ sha256: hash.digest('hex'), bytes: fs.statSync(destino).size });
    };

    p.stdout.on('data', (c) => { actual.crudo = (actual.crudo || 0) + c.length; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', (e) => { fs.rm(cnf, { force: true }, () => {}); reject(e); });
    p.on('close', (c) => { codigo = c; fin(); });
    gz.on('data', (c) => hash.update(c));
    out.on('finish', () => { escrito = true; fin(); });
    out.on('error', reject);
    p.stdout.pipe(gz).pipe(out);
  });
}

/* -------------------------------- subida -------------------------------- */

function subir(ruta, meta) {
  const { servidorUrl, apiKey } = ajustes.get();
  const u = new URL(servidorUrl + '/api/respaldo');
  const mod = u.protocol === 'https:' ? require('https') : require('http');
  const total = fs.statSync(ruta).size;

  return new Promise((resolve, reject) => {
    const rq = mod.request(u, {
      method: 'POST',
      headers: {
        'Content-Type':   'application/gzip',
        'Content-Length': total,
        'Authorization':  'Bearer ' + apiKey,
        'X-Sha256':       meta.sha256,
        'X-Base-Origen':  meta.base,
        'X-Nota':         encodeURIComponent(meta.nota || '')
      }
    }, (res) => {
      let txt = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { txt += c; });
      res.on('end', () => {
        let cuerpo = null;
        try { cuerpo = JSON.parse(txt); } catch { /* noop */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(cuerpo || {});
        reject(new Error(`el servidor respondió ${res.statusCode}: ${(cuerpo && cuerpo.error) || txt.slice(0, 200)}`));
      });
    });
    rq.on('error', (e) => reject(new Error(`no se pudo subir a ${servidorUrl} (${e.code || e.message})`)));
    const rs = fs.createReadStream(ruta);
    rs.on('data', (c) => { actual.subido = (actual.subido || 0) + c.length; });
    rs.on('error', reject);
    rs.pipe(rq);
  });
}

/* ------------------------------- orquesta ------------------------------- */

/**
 * Arranca el respaldo en background. Lanza error si ya hay uno en curso o si
 * falta configuración; el resultado se ve en estado().
 */
function iniciar({ nota } = {}) {
  if (ocupado()) throw new Error('ya hay un respaldo en curso');
  const a = ajustes.get();
  if (!a.db.host || !a.db.user || !a.db.database) throw new Error('configura la base de datos primero');
  if (!a.servidorUrl || !a.apiKey) throw new Error('configura la URL y la API key del servidor primero');
  const md = detectar();
  if (!md) throw new Error('no se encontró mysqldump: indica su ruta en el panel (p.ej. C:\\Program Files\\MySQL\\MySQL Server 5.7\\bin)');

  fs.mkdirSync(DIR, { recursive: true });
  const archivo = path.join(DIR, `${a.db.database}_${Date.now()}.sql.gz`);
  actual = { fase: 'volcando', inicio: new Date().toISOString(), base: a.db.database, crudo: 0, mysqldump: md.ruta };
  log.info(`respaldo: volcando ${a.db.database} con ${md.ruta}`);

  (async () => {
    try {
      const v = await volcar(md, a.db, archivo);
      actual = { ...actual, fase: 'subiendo', bytes: v.bytes, subido: 0 };
      log.info(`respaldo: ${(v.bytes / 1048576).toFixed(1)} MB comprimido, subiendo al servidor`);
      const r = await subir(archivo, { sha256: v.sha256, base: a.db.database, nota: String(nota || '').slice(0, 255) || os.hostname() });
      actual = { ...actual, fase: 'listo', fin: new Date().toISOString(), id: r.respaldo && r.respaldo.id };
      log.info(`respaldo: recibido por el servidor (#${actual.id}); queda pendiente de aprobación allá`);
    } catch (e) {
      actual = { ...actual, fase: 'error', fin: new Date().toISOString(), error: e.message };
      log.error('respaldo: ' + e.message);
    } finally {
      fs.rm(archivo, { force: true }, () => {});
    }
  })();
  return actual;
}

module.exports = { iniciar, detectar, estado: () => actual, ocupado };
