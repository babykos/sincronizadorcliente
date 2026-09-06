const db      = require('./db');
const ajustes = require('./ajustes');
const esquema = require('./esquema');
const log     = require('./log');
const { refrescarNodo, usarMapaPk } = require('./sincronizar');

// Deja la BD lista para sincronizar: tabla sync_control + triggers + mapa de PKs,
// y recupera el cursor del servidor. Idempotente.

let hecho = false;

function listo() {
  return db.configurada() && ajustes.servidorConfigurado();
}

async function asegurar({ forzarTriggers = false } = {}) {
  if (!db.configurada()) return { ok: false, motivo: 'BD sin configurar' };

  const pool = db.getPool();
  await esquema.asegurarTablaControl(pool);
  const lista = await esquema.asegurarTriggers(pool, { forzar: forzarTriggers });
  usarMapaPk(Object.fromEntries(lista.map(x => [x.tabla, x.pk])));

  let nodo = null;
  if (ajustes.servidorConfigurado()) {
    try { nodo = await refrescarNodo(); }
    catch (e) { log.warn('refrescarNodo al preparar: ' + e.message); }
  }

  hecho = listo();
  return { ok: true, tablas: lista.length, nodo: nodo && nodo.nodo && nodo.nodo.codigo };
}

module.exports = { asegurar, listo, estaHecho: () => hecho, reset: () => { hecho = false; } };
