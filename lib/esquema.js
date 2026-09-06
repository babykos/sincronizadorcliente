const log = require('./log');
const seleccionTablas = require('./seleccionTablas');

// Tipos que NO entran al payload (binarios: peso y codificación).
const BLOBS = ['blob', 'tinyblob', 'mediumblob', 'longblob', 'binary', 'varbinary'];

const DDL_SYNC_CONTROL = `
CREATE TABLE IF NOT EXISTS sync_control (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  identificador CHAR(36)        NOT NULL,
  tabla_origen  VARCHAR(128)    NOT NULL,
  registro_pk   VARCHAR(190)    NULL,
  tipo_evento   ENUM('INSERT','UPDATE','DELETE') NOT NULL,
  payload       JSON            NOT NULL,
  origen_at     DATETIME(6)     NOT NULL,
  estado        ENUM('PENDIENTE','ENVIADO','APLICADO','ERROR') NOT NULL DEFAULT 'PENDIENTE',
  intentos      INT UNSIGNED    NOT NULL DEFAULT 0,
  error_mensaje TEXT            NULL,
  seq_servidor  BIGINT UNSIGNED NULL,
  creado_en     DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  enviado_en    DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_identificador (identificador),
  KEY idx_outbox (estado, id),
  KEY idx_registro (tabla_origen, registro_pk)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

async function asegurarTablaControl(pool) {
  await pool.query(DDL_SYNC_CONTROL);
  // instalaciones viejas: agregar el estado APLICADO al ENUM si falta
  try {
    const [[c]] = await pool.query(
      `SELECT COLUMN_TYPE ct FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_control' AND COLUMN_NAME = 'estado'`);
    if (c && !/APLICADO/.test(c.ct)) {
      await pool.query(
        `ALTER TABLE sync_control MODIFY COLUMN estado
           ENUM('PENDIENTE','ENVIADO','APLICADO','ERROR') NOT NULL DEFAULT 'PENDIENTE'`);
      log.info('sync_control.estado: agregado APLICADO al ENUM');
    }
  } catch (e) { log.warn('no se pudo revisar el ENUM de sync_control.estado: ' + e.message); }
}

async function tablaExiste(pool, tabla) {
  const [f] = await pool.query(
    `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [tabla]);
  return f.length > 0;
}

// PK de UNA sola columna, o null si la PK es compuesta / no hay.
async function pkDe(pool, tabla) {
  const [f] = await pool.query(`
    SELECT MIN(k.COLUMN_NAME) AS pk
    FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.TABLE_CONSTRAINTS c
      ON c.TABLE_SCHEMA = k.TABLE_SCHEMA AND c.TABLE_NAME = k.TABLE_NAME
     AND c.CONSTRAINT_NAME = k.CONSTRAINT_NAME
    WHERE c.CONSTRAINT_TYPE = 'PRIMARY KEY'
      AND k.TABLE_SCHEMA = DATABASE()
      AND k.TABLE_NAME = ?
    GROUP BY k.TABLE_NAME
    HAVING COUNT(*) = 1`, [tabla]);
  return f.length ? f[0].pk : null;
}

async function todasConPkSimple(pool) {
  const [filas] = await pool.query(`
    SELECT k.TABLE_NAME AS tabla, MIN(k.COLUMN_NAME) AS pk
    FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.TABLE_CONSTRAINTS c
      ON c.TABLE_SCHEMA = k.TABLE_SCHEMA AND c.TABLE_NAME = k.TABLE_NAME
     AND c.CONSTRAINT_NAME = k.CONSTRAINT_NAME
    WHERE c.CONSTRAINT_TYPE = 'PRIMARY KEY'
      AND k.TABLE_SCHEMA = DATABASE()
      AND k.TABLE_NAME <> 'sync_control'
    GROUP BY k.TABLE_NAME
    HAVING COUNT(*) = 1
    ORDER BY k.TABLE_NAME`);
  return filas;
}

const INTERNAS = new Set(['sync_control', 'id_secuencias', 'local']);

/**
 * Lista [{ tabla, pk }] de las tablas que participan de la sincronización, según
 * tablas.json. Es la MISMA lista para los dos tipos de trigger: los de rango
 * (before_insert_) y los de captura (sync_ai_/au/ad_).
 *  - modo "lista": solo las de "incluir" (pk del archivo o autodetectada).
 *  - modo "auto":  todas las de PK simple.
 *  - "excluir" y las tablas internas siempre se descartan.
 */
async function tablasSeleccionadas(pool) {
  const sel     = seleccionTablas.cargar();
  const excluir = new Set([...sel.excluir, ...INTERNAS]);

  if (sel.modo === 'lista') {
    const out = [];
    for (const { tabla, pk } of sel.incluir) {
      if (excluir.has(tabla)) continue;
      if (!(await tablaExiste(pool, tabla))) { log.warn(`tablas.json: "${tabla}" no existe en la base, se omite`); continue; }
      const pkFinal = pk || await pkDe(pool, tabla);
      if (!pkFinal) { log.warn(`tablas.json: "${tabla}" sin PK de una columna y sin "pk" en el archivo, se omite`); continue; }
      out.push({ tabla, pk: pkFinal });
    }
    log.info(`selección: ${out.length} tablas (modo lista, ${sel.archivo})`);
    return out;
  }

  const filas = await todasConPkSimple(pool);
  const out = filas
    .filter(f => !excluir.has(f.tabla.toLowerCase()))
    .map(f => ({ tabla: f.tabla, pk: f.pk }));
  log.info(`selección: ${out.length} tablas (modo auto, ${sel.archivo}, ${sel.excluir.length} excluidas)`);
  return out;
}

// Alias históricos: ambos tipos de trigger usan la misma selección.
const tablasSincronizables = tablasSeleccionadas;
const tablasParaSecuencias  = tablasSeleccionadas;

async function columnasDe(pool, tabla) {
  const [filas] = await pool.query(`
    SELECT COLUMN_NAME AS c
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      AND DATA_TYPE NOT IN (?)
      AND EXTRA NOT LIKE '%GENERATED%'
    ORDER BY ORDINAL_POSITION`, [tabla, BLOBS]);
  return filas.map(f => f.c);
}

function jsonObject(columnas, ref) {
  return 'JSON_OBJECT(' + columnas.map(c => `'${c}', ${ref}.\`${c}\``).join(', ') + ')';
}

function sqlCrearTrigger(nombre, momento, tabla, ref, tipoEvento, pk, columnas) {
  return `CREATE TRIGGER \`${nombre}\` ${momento} ON \`${tabla}\` FOR EACH ROW
BEGIN
  IF @sync_nodo IS NULL THEN
    INSERT INTO sync_control (identificador, tabla_origen, registro_pk, tipo_evento, payload, origen_at)
    VALUES (UUID(), '${tabla}', ${ref}.\`${pk}\`, '${tipoEvento}', ${jsonObject(columnas, ref)}, NOW(6));
  END IF;
END`;
}

async function triggersSyncExistentes(pool) {
  const [filas] = await pool.query(`
    SELECT TRIGGER_NAME AS n, EVENT_OBJECT_TABLE AS t
    FROM information_schema.TRIGGERS
    WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME LIKE 'sync\\_a_\\_%'`);
  return filas;   // [{ n, t }]
}

/**
 * Deja los triggers sync_ai_/au/ad_ EXACTAMENTE para las tablas de
 * tablasSincronizables(): crea los que faltan y BORRA los de tablas que ya no
 * están en la selección. { forzar: true }: recrea todos.
 * Devuelve la lista [{ tabla, pk }].
 */
async function asegurarTriggers(pool, { forzar = false } = {}) {
  const lista      = await tablasSincronizables(pool);
  const existentes = await triggersSyncExistentes(pool);
  const nombresExist = new Set(existentes.map(x => x.n));
  const tablasOk = new Set(lista.map(x => x.tabla.toLowerCase()));

  // 1) huérfanos: triggers sync_* de tablas que ya no se sincronizan
  let eliminados = 0;
  for (const { n, t } of existentes) {
    if (!tablasOk.has(String(t).toLowerCase())) {
      await pool.query(`DROP TRIGGER IF EXISTS \`${n}\``);
      eliminados++;
    }
  }
  if (eliminados) log.info(`triggers huérfanos eliminados: ${eliminados}`);

  // 2) crear / recrear
  let recreados = 0, tablasTocadas = 0;
  for (const { tabla, pk } of lista) {
    const defs = [
      ['sync_ai_' + tabla, 'AFTER INSERT', 'NEW', 'INSERT'],
      ['sync_au_' + tabla, 'AFTER UPDATE', 'NEW', 'UPDATE'],
      ['sync_ad_' + tabla, 'AFTER DELETE', 'OLD', 'DELETE']
    ];
    if (!forzar && defs.every(([n]) => nombresExist.has(n))) continue;

    const columnas = await columnasDe(pool, tabla);
    if (columnas.length === 0) { log.warn(`sin columnas utilizables, se omite: ${tabla}`); continue; }

    for (const [nombre, momento, ref, tipoEvento] of defs) {
      await pool.query(`DROP TRIGGER IF EXISTS \`${nombre}\``);
      await pool.query(sqlCrearTrigger(nombre, momento, tabla, ref, tipoEvento, pk, columnas));
      recreados++;
    }
    tablasTocadas++;
  }

  log.info(`triggers: ${recreados} (re)creados en ${tablasTocadas} tablas; ${lista.length} sincronizables`);
  return lista;
}

module.exports = { asegurarTablaControl, asegurarTriggers, tablasSeleccionadas, tablasSincronizables, tablasParaSecuencias, columnasDe };
