const fs   = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const RUTA = path.join(RAIZ, 'tablas.json');

// Define QUÉ tablas participan de la sincronización. Vive SIEMPRE en tablas.json
// (raíz del proyecto). A esas tablas se les crean los dos tipos de triggers:
// los de rango (before_insert_) y los de captura (sync_ai_/au/ad_).
//
//   modo = "lista"  -> SOLO las de "incluir". Cada entrada: { "tabla": "...", "pk": "..." }
//                      (la pk es opcional; si falta se detecta de information_schema).
//                      También se aceptan ["tabla","pk"] o "tabla" a secas.
//   modo = "auto"   -> TODAS las tablas con PK de una sola columna, menos "excluir".
//
//   "excluir" siempre gana, en los dos modos y para los dos tipos de trigger.

function normalizarEntrada(e) {
  if (typeof e === 'string')  return { tabla: e.trim().toLowerCase(), pk: null };
  if (Array.isArray(e))       return { tabla: String(e[0]).trim().toLowerCase(), pk: e[1] ? String(e[1]).trim() : null };
  return { tabla: String(e.tabla).trim().toLowerCase(), pk: e.pk ? String(e.pk).trim() : null };
}

function cargar() {
  if (!fs.existsSync(RUTA)) {
    throw new Error('Falta tablas.json en la raíz del proyecto. Define ahí qué tablas se sincronizan (modo / incluir / excluir).');
  }
  const d = JSON.parse(fs.readFileSync(RUTA, 'utf8'));
  return {
    archivo: 'tablas.json',
    modo:    d.modo === 'lista' ? 'lista' : 'auto',
    incluir: (d.incluir || []).map(normalizarEntrada),
    excluir: (d.excluir || []).map(s => String(s).trim().toLowerCase())
  };
}

module.exports = { cargar };
