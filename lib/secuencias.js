const log     = require('./log');
const esquema = require('./esquema');

// Réplica de la lógica de frmTriggers.java (Maverick):
// cada nodo tiene una LETRA (sucursal) y un RANGO de IDs [desde, hasta). Se crea
// un trigger BEFORE INSERT por tabla que, si la PK viene NULL o 0, la toma de
// id_secuencias (por sucursal + entidad) y avanza el contador. Así dos nodos
// nunca generan la misma PK.

const DDL_ID_SECUENCIAS = `
CREATE TABLE IF NOT EXISTS id_secuencias (
  sucursal CHAR(2)     NOT NULL,
  entidad  VARCHAR(64) NOT NULL,
  ultimo   BIGINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (sucursal, entidad)
) ENGINE=InnoDB`;

const DDL_LOCAL = `
CREATE TABLE IF NOT EXISTS local (
  llave VARCHAR(255) NOT NULL,
  valor VARCHAR(255) NOT NULL,
  PRIMARY KEY (llave)
) ENGINE=InnoDB`;

async function asegurarTablas(pool) {
  await pool.query(DDL_ID_SECUENCIAS);
  await pool.query(DDL_LOCAL);
}

// Guarda LETRA / RANGO_INICIO / RANGO_FIN en la tabla `local` (como frmTriggers).
async function guardarParametrosLocal(pool, { letra, desde, hasta }) {
  for (const [llave, valor] of [['LETRA', letra], ['RANGO_INICIO', desde], ['RANGO_FIN', hasta]]) {
    await pool.query(
      `INSERT INTO local (llave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
      [llave, String(valor)]
    );
  }
}

// Lee los parámetros guardados en `local` (si existen).
async function leerParametrosLocal(pool) {
  try {
    const [filas] = await pool.query(
      `SELECT llave, valor FROM local WHERE llave IN ('LETRA','RANGO_INICIO','RANGO_FIN')`);
    const m = {};
    for (const f of filas) m[f.llave] = f.valor;
    return { letra: m.LETRA || '', desde: m.RANGO_INICIO || '', hasta: m.RANGO_FIN || '' };
  } catch { return { letra: '', desde: '', hasta: '' }; }
}

function sqlBeforeInsert(tabla, pk, sucursal) {
  return `CREATE TRIGGER \`before_insert_${tabla}\` BEFORE INSERT ON \`${tabla}\`
FOR EACH ROW BEGIN
  DECLARE nuevo_id BIGINT;
  IF NEW.\`${pk}\` IS NULL OR NEW.\`${pk}\` = 0 THEN
    SELECT ultimo INTO nuevo_id
      FROM id_secuencias
     WHERE sucursal = '${sucursal}' AND entidad = '${tabla}'
     FOR UPDATE;
    SET NEW.\`${pk}\` = nuevo_id + 1;
    UPDATE id_secuencias SET ultimo = nuevo_id + 1
     WHERE sucursal = '${sucursal}' AND entidad = '${tabla}';
  END IF;
END`;
}

async function triggersRangoExistentes(pool) {
  const [filas] = await pool.query(`
    SELECT TRIGGER_NAME AS n, EVENT_OBJECT_TABLE AS t
    FROM information_schema.TRIGGERS
    WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME LIKE 'before\\_insert\\_%'`);
  return filas;
}

/**
 * Aplica el esquema de rangos: crea id_secuencias/local, guarda los parámetros,
 * y por cada tabla recrea el trigger before_insert_ y siembra id_secuencias con
 * el MAX(pk) que ya exista dentro del rango (lógica de frmTriggers.Procesar).
 */
async function aplicar(pool, { letra, desde, hasta }) {
  const suc = String(letra).trim();
  const d = parseInt(desde, 10);
  const h = parseInt(hasta, 10);
  if (!suc || suc.length > 2) throw new Error('la letra/sucursal debe ser 1 o 2 caracteres');
  if (!Number.isFinite(d) || !Number.isFinite(h) || d >= h) throw new Error('rango inválido (desde < hasta, enteros)');

  await asegurarTablas(pool);
  await guardarParametrosLocal(pool, { letra: suc, desde: d, hasta: h });

  const lista = await esquema.tablasParaSecuencias(pool);
  const enLista = new Set(lista.map(x => x.tabla.toLowerCase()));

  // huérfanos: before_insert_ de tablas que ya no están
  let eliminados = 0;
  for (const { n, t } of await triggersRangoExistentes(pool)) {
    if (!enLista.has(String(t).toLowerCase())) {
      await pool.query(`DROP TRIGGER IF EXISTS \`${n}\``);
      eliminados++;
    }
  }

  let creados = 0;
  for (const { tabla, pk } of lista) {
    await pool.query(`DROP TRIGGER IF EXISTS \`before_insert_${tabla}\``);
    await pool.query(sqlBeforeInsert(tabla, pk, suc));

    // sembrar id_secuencias con lo que ya haya en el rango (frmTriggers.ObtenerUltimoID)
    const [[r]] = await pool.query(
      `SELECT IFNULL(MAX(\`${pk}\`), ?) AS ultimo FROM \`${tabla}\` WHERE \`${pk}\` >= ? AND \`${pk}\` < ?`,
      [d, d, h]
    );
    await pool.query(
      `INSERT INTO id_secuencias (sucursal, entidad, ultimo) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE ultimo = VALUES(ultimo)`,
      [suc, tabla, Number(r.ultimo)]
    );
    creados++;
  }

  log.info(`secuencias: sucursal '${suc}' rango [${d}, ${h}) — ${creados} triggers before_insert, ${eliminados} huérfanos borrados`);
  return { sucursal: suc, desde: d, hasta: h, tablas: creados, huerfanos: eliminados };
}

module.exports = { aplicar, asegurarTablas, leerParametrosLocal };
