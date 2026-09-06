const fs   = require('fs');
const path = require('path');

// Estado de máquina (no es config): sobre todo el cursor de sincronización.
// La "verdad" del cursor la tiene el servidor (nodos.cursor_aplicado); esto es
// una caché para no re-pedir todo el historial en cada arranque.

const DIR     = path.join(__dirname, '..', 'state');
const ARCHIVO = path.join(DIR, 'estado.json');

let mem = { cursor: 0, nodoCodigo: null, ultimaSync: null };

function cargar() {
  try {
    mem = { ...mem, ...JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')) };
  } catch { /* primera vez: se queda con los valores por defecto */ }
  return mem;
}

function guardar(parcial = {}) {
  mem = { ...mem, ...parcial };
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = ARCHIVO + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(mem, null, 2));
  fs.renameSync(tmp, ARCHIVO);   // escritura atómica
  return mem;
}

module.exports = { cargar, guardar, get: () => mem };
