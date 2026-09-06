const { intervaloSegundos, puerto, archivoConfig } = require('./config');
const log      = require('./lib/log');
const db       = require('./lib/db');
const estado   = require('./lib/estado');
const ajustes  = require('./lib/ajustes');
const preparar = require('./lib/preparar');
const { unCiclo } = require('./lib/sincronizar');
const estadoHttp  = require('./lib/estadoHttp');

let corriendo = true;
const parar = () => { if (corriendo) { log.info('señal de parada recibida'); corriendo = false; } };
process.on('SIGINT', parar);
process.on('SIGTERM', parar);

const dormir = (ms) => new Promise(r => setTimeout(r, ms));

async function bucle() {
  let avisado = false, avisadoReseed = false;
  while (corriendo) {
    try {
      if (!preparar.listo()) {
        if (!avisado) { log.warn(`falta configuración — panel en http://127.0.0.1:${puerto}`); avisado = true; }
      } else {
        avisado = false;
        if (!preparar.estaHecho()) await preparar.asegurar();

        const pool = db.getPool();
        let r, vueltas = 0;
        do {
          r = await unCiclo(pool);
          if (r.sinConfig) break;
          if (r.reseed) {
            if (!avisadoReseed) {
              log.error(`RE-SEED REQUERIDO: este nodo está muy atrás. Resembrá la base y fijá el cursor en http://127.0.0.1:${puerto}`);
              avisadoReseed = true;
            }
            break;
          }
          avisadoReseed = false;
          if (r.enviados || r.errores || r.aplicados || r.confirmados) {
            log.info(`push +${r.enviados} (${r.errores} err) · pull ${r.aplicados} aplic · ${r.confirmados} confirmados · cursor=${estado.get().cursor || 0}`);
          }
        } while (corriendo && r.hayMas && ++vueltas < 50);
      }
    } catch (e) {
      if (e.red || e.sinConfig) log.warn(e.message);
      else log.error('ciclo falló: ' + (e.stack || e.message));
    }
    for (let i = 0; i < intervaloSegundos && corriendo; i++) await dormir(1000);
  }
}

(async () => {
  log.info('=== sincronizador cliente ===');
  ajustes.cargar();
  estado.cargar();

  let server;
  try {
    // el panel arranca SIEMPRE, aunque no haya nada configurado todavía
    server = estadoHttp.iniciar({ corriendo: () => corriendo });

    if (db.configurada()) {
      try { await preparar.asegurar({ forzarTriggers: process.argv.includes('--recrear-triggers') }); }
      catch (e) { log.warn('preparar al iniciar: ' + e.message); }
    }
    log.info(`nodo ${estado.get().nodoCodigo || '?'}  cursor ${estado.get().cursor || 0}  (config: ${archivoConfig || 'defaults'})`);

    await bucle();
  } catch (e) {
    log.error('fallo fatal: ' + (e.stack || e.message));
    process.exitCode = 1;
  } finally {
    if (server) server.close();
    await db.cerrar();
    log.info('detenido');
  }
})();
