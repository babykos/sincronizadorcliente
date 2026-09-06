const fs   = require('fs');
const path = require('path');
const { log: cfg } = require('../config');

const NIVELES = { error: 0, warn: 1, info: 2, debug: 3 };
const umbral  = NIVELES[cfg.nivel] ?? 2;
const archivo = cfg.archivo ? path.join(__dirname, '..', cfg.archivo) : null;

if (archivo) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
}

function emit(nivel, args) {
  if ((NIVELES[nivel] ?? 2) > umbral) return;
  const linea = `${new Date().toISOString()} [${nivel.toUpperCase()}] ${args.map(String).join(' ')}`;
  (nivel === 'error' ? console.error : console.log)(linea);
  if (archivo) {
    try { fs.appendFileSync(archivo, linea + '\n'); } catch { /* disco lleno / permisos: no romper el loop */ }
  }
}

module.exports = {
  error: (...a) => emit('error', a),
  warn:  (...a) => emit('warn', a),
  info:  (...a) => emit('info', a),
  debug: (...a) => emit('debug', a)
};
