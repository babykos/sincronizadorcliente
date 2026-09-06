const fs   = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');

// Config de COMPORTAMIENTO (no credenciales): config.json si existe, si no el .example.
// Las credenciales / URL / api_key NO viven aquí: se configuran desde el panel (:3010)
// y se guardan en state/ajustes.json.
function cargarJson() {
  for (const nombre of ['config.json', 'config.example.json']) {
    const ruta = path.join(RAIZ, nombre);
    if (fs.existsSync(ruta)) {
      return { archivo: nombre, datos: JSON.parse(fs.readFileSync(ruta, 'utf8')) };
    }
  }
  return { archivo: null, datos: {} };
}

const { archivo, datos } = cargarJson();

module.exports = {
  archivoConfig: archivo,

  puerto:            datos.puerto ?? 3010,
  intervaloSegundos: datos.intervaloSegundos ?? 15,
  lotePush:          datos.lotePush ?? 500,
  lotePull:          datos.lotePull ?? 1000,
  log:               datos.log ?? { nivel: 'info', archivo: 'state/sincronizador.log' }
  // La selección de tablas va en tablas.json (ver lib/seleccionTablas.js).
};
