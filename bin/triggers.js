// Recrea sync_control y TODOS los triggers sync_ai_/au/ad_ según tablas.json.
// Correr tras un cambio de esquema o de la lista de tablas.
//   npm run triggers
const db       = require('../lib/db');
const ajustes  = require('../lib/ajustes');
const preparar = require('../lib/preparar');
const log      = require('../lib/log');

(async () => {
  ajustes.cargar();
  if (!db.configurada()) {
    log.error('BD sin configurar. Configúrala en el panel http://127.0.0.1:3010 y vuelve a correr esto.');
    process.exit(1);
  }
  const r = await preparar.asegurar({ forzarTriggers: true });
  await db.cerrar();
  log.info(`listo: ${r.tablas} tablas`);
})().catch(e => {
  log.error(e.stack || e.message);
  process.exit(1);
});
