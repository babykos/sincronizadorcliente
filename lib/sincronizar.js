const { lotePush, lotePull } = require('../config');
const api     = require('./api');
const log     = require('./log');
const estado  = require('./estado');
const ajustes = require('./ajustes');
const { aplicarLote } = require('./aplicar');

// Reintentos de una fila que el servidor rechazó en el push.
const MAX_PUSH_INTENTOS = 6;

// mapa { tabla: pkCol } que arma app.js al iniciar (para los DELETE)
let MAPA_PK = {};
function usarMapaPk(m) { MAPA_PK = m; }

let ultimoResumen = { enviados: 0, errores: 0, aplicados: 0, confirmados: 0, hayMas: false, ts: null };

function aEvento(fila) {
  return {
    identificador: fila.identificador,
    tipo_evento:   fila.tipo_evento,
    tabla_origen:  fila.tabla_origen,
    registro_pk:   fila.registro_pk,
    origen_at:     fila.origen_at,
    payload:       typeof fila.payload === 'string' ? JSON.parse(fila.payload) : fila.payload
  };
}

// Consulta /api/nodo y ajusta el cursor / código de nodo local.
async function refrescarNodo() {
  const n = await api.nodo();
  const cur = n && n.cursor_aplicado;
  if (typeof cur === 'number' && cur > (estado.get().cursor || 0)) {
    log.warn(`cursor local ${estado.get().cursor || 0} -> servidor ${cur}`);
    estado.guardar({ cursor: cur });
  }
  if (n && n.nodo && n.nodo.codigo) estado.guardar({ nodoCodigo: n.nodo.codigo });
  if (n && n.empresa) estado.guardar({ empresa: n.empresa });
  return n;
}

// ---------------------------------------------------------------- PUSH
async function pushFase(pool) {
  const lim = Math.max(1, Math.min(Number(lotePush) || 500, 1000));
  const [filas] = await pool.query(
    `SELECT id, identificador, tabla_origen, registro_pk, tipo_evento, payload, origen_at
       FROM sync_control
      WHERE estado = 'PENDIENTE'
         OR (estado = 'ERROR' AND intentos < ${MAX_PUSH_INTENTOS})
      ORDER BY id
      LIMIT ${lim}`);
  if (filas.length === 0) return { enviados: 0, errores: 0 };

  const eventos = filas.map(aEvento);
  let recibidos;
  try {
    ({ recibidos } = await api.push(eventos));
  } catch (e) {
    if (e.status === 404) {                       // servidor viejo
      recibidos = (await api.pushEventos(eventos)).resultados || [];
      log.warn('servidor sin /api/push: usando /api/sync/eventos');
    } else throw e;
  }

  const porIdent = new Map(filas.map(f => [f.identificador, f.id]));
  let enviados = 0, errores = 0;
  for (const r of recibidos || []) {
    const id = porIdent.get(r.identificador);
    if (!id) continue;
    if (r.error) {
      await pool.query(
        `UPDATE sync_control SET estado='ERROR', intentos=intentos+1, error_mensaje=? WHERE id=?`,
        [String(r.error).slice(0, 500), id]);
      errores++;
    } else {
      await pool.query(
        `UPDATE sync_control SET estado='ENVIADO', enviado_en=NOW(), seq_servidor=?, error_mensaje=NULL WHERE id=?`,
        [r.seq ?? null, id]);
      enviados++;
    }
  }
  return { enviados, errores };
}

// ---------------------------------------------------------------- PULL
async function pullFase(pool) {
  const cursor = estado.get().cursor || 0;

  // eventos ya enviados de los que espero confirmación de aplicado en la maestra
  const [esp] = await pool.query(
    `SELECT identificador FROM sync_control WHERE estado = 'ENVIADO' ORDER BY id LIMIT 1000`);
  const esperando = esp.map(r => r.identificador);

  let resp;
  try {
    resp = await api.pull({ cursor, max_pull: lotePull, esperando });
  } catch (e) {
    if (e.status === 404) {                       // servidor viejo
      resp = await api.sync({ cursor, eventos: [], max_pull: lotePull });
      resp.confirmados = [];
      log.warn('servidor sin /api/pull: usando /api/sync (sin confirmación de aplicado)');
    } else throw e;
  }

  // confirmaciones de la maestra: ENVIADO -> APLICADO / ERROR
  let confirmados = 0;
  for (const c of resp.confirmados || []) {
    if (c.estado === 'APLICADO') {
      await pool.query(
        `UPDATE sync_control SET estado='APLICADO' WHERE identificador=? AND estado='ENVIADO'`,
        [c.identificador]);
    } else {
      await pool.query(
        `UPDATE sync_control SET estado='ERROR', error_mensaje=? WHERE identificador=? AND estado='ENVIADO'`,
        [('maestra: ' + (c.error || 'error')).slice(0, 500), c.identificador]);
      log.error(`la maestra rechazó ${c.identificador}: ${c.error}`);
    }
    confirmados++;
  }

  estado.guardar({ empresaPausada: Boolean(resp.empresa_pausada), empresaError: resp.empresa_error || null });

  if (resp.reseed_requerido) {
    estado.guardar({ reseedRequerido: true, seqActual: resp.seq_actual || 0 });
    return { aplicados: 0, confirmados, hayMas: false, reseed: true };
  }
  if (estado.get().reseedRequerido) estado.guardar({ reseedRequerido: false });

  const cambios = resp.cambios || [];
  let saltados = [];
  if (cambios.length) {
    ({ saltados } = await aplicarLote(pool, cambios, MAPA_PK));
    if (saltados.length) estado.guardar({ saltados: saltados.slice(-20) });
  }
  if (typeof resp.cursor === 'number' && resp.cursor > cursor) {
    estado.guardar({ cursor: resp.cursor, ultimaSync: new Date().toISOString() });
  }
  return { aplicados: cambios.length, confirmados, hayMas: !!resp.hay_mas };
}

async function unCiclo(pool) {
  if (!ajustes.servidorConfigurado()) {
    return { enviados: 0, errores: 0, aplicados: 0, hayMas: false, sinConfig: true };
  }
  const p = await pushFase(pool);
  const q = await pullFase(pool);
  const r = {
    enviados:    p.enviados,
    errores:     p.errores,
    aplicados:   q.aplicados,
    confirmados: q.confirmados,
    hayMas:      q.hayMas,
    reseed:      q.reseed
  };
  ultimoResumen = { ...r, ts: new Date().toISOString() };
  return r;
}

// Fija el cursor a mano (tras un re-seed manual de la base).
function fijarCursor(n) {
  const v = Math.max(0, parseInt(n, 10) || 0);
  estado.guardar({ cursor: v, reseedRequerido: false, ultimaSync: new Date().toISOString() });
  return v;
}

async function contarPendientes(pool) {
  try {
    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS n FROM sync_control WHERE estado IN ('PENDIENTE','ERROR')`);
    return row.n;
  } catch { return null; }
}

async function contarEstados(pool) {
  try {
    const [filas] = await pool.query(
      `SELECT estado, COUNT(*) n FROM sync_control GROUP BY estado`);
    const o = { PENDIENTE: 0, ENVIADO: 0, APLICADO: 0, ERROR: 0 };
    for (const f of filas) o[f.estado] = f.n;
    return o;
  } catch { return null; }
}

module.exports = {
  unCiclo, refrescarNodo, usarMapaPk, fijarCursor,
  contarPendientes, contarEstados, resumen: () => ultimoResumen
};
