const log = require('./log');

// Reintentos por evento antes de saltarlo (el ciclo completo reintenta cada
// intervaloSegundos, así que 4 ≈ 1 minuto de reintentos).
const MAX_INTENTOS = 4;
const fallos = new Map();   // seq -> nº de intentos fallidos seguidos

// Construye un upsert idempotente: si la fila no existe la inserta, si existe
// la pisa con los valores entrantes (last-write-wins por orden de llegada al hub).
function sqlUpsert(tabla, datos) {
  const cols = Object.keys(datos);
  const marc = cols.map(() => '?').join(', ');
  const set  = cols.map(c => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');
  return {
    sql: `INSERT INTO \`${tabla}\` (${cols.map(c => `\`${c}\``).join(', ')}) VALUES (${marc}) ` +
         `ON DUPLICATE KEY UPDATE ${set}`,
    valores: cols.map(c => datos[c])
  };
}

async function aplicarUno(conn, cambio, mapaPk) {
  const tabla = cambio.tabla_origen;
  const datos = typeof cambio.payload === 'string' ? JSON.parse(cambio.payload) : cambio.payload;

  // anti-eco: el trigger ve esta variable y NO registra lo que aquí escribimos
  await conn.query('SET @sync_nodo = ?', [cambio.origen || '*']);

  if (cambio.tipo_evento === 'DELETE') {
    const pk = mapaPk[tabla];
    if (!pk) { log.warn(`DELETE ignorado (tabla no sincronizable localmente): ${tabla}`); return; }
    await conn.query(`DELETE FROM \`${tabla}\` WHERE \`${pk}\` = ?`, [cambio.registro_pk]);
    return;
  }

  if (!datos || Object.keys(datos).length === 0) {
    log.warn(`${cambio.tipo_evento} sin payload, se omite: ${tabla}`);
    return;
  }
  const { sql, valores } = sqlUpsert(tabla, datos);
  await conn.query(sql, valores);
}

/**
 * Aplica un lote de cambios remotos en UNA transacción, sobre UNA conexión.
 * - Un evento que falla aborta el lote y se reintenta el ciclo siguiente.
 * - Si el MISMO evento falla MAX_INTENTOS veces, se SALTA (se registra fuerte)
 *   para no congelar la sincronización de todo el nodo por una fila.
 * Devuelve { saltados: [{seq,tabla,pk,error}] }.
 */
async function aplicarLote(pool, cambios, mapaPk) {
  const conn = await pool.getConnection();
  const saltados = [];
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    await conn.beginTransaction();

    for (const c of cambios) {
      try {
        await aplicarUno(conn, c, mapaPk);
        fallos.delete(c.seq);
      } catch (e) {
        const n = (fallos.get(c.seq) || 0) + 1;
        fallos.set(c.seq, n);
        if (n < MAX_INTENTOS) throw e;          // aborta el lote -> se reintenta
        fallos.delete(c.seq);
        saltados.push({ seq: c.seq, tabla: c.tabla_origen, pk: c.registro_pk, error: e.message });
        log.error(`SALTANDO evento seq ${c.seq} (${c.tabla_origen} pk=${c.registro_pk}) tras ${MAX_INTENTOS} intentos: ${e.message}`);
        // continúa con el resto del lote
      }
    }

    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw e;
  } finally {
    try { await conn.query('SET @sync_nodo = NULL'); } catch { /* ignore */ }
    try { await conn.query('SET FOREIGN_KEY_CHECKS = 1'); } catch { /* ignore */ }
    conn.release();
  }
  return { saltados };
}

module.exports = { aplicarLote };
