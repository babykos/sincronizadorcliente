const ajustes = require('./ajustes');

const TIMEOUT_MS = 30000;

async function req(ruta, opciones = {}) {
  const { servidorUrl, apiKey } = ajustes.get();
  if (!servidorUrl || !apiKey) {
    const err = new Error('falta configurar la URL y la API key del servidor (panel :3010)');
    err.sinConfig = true;
    throw err;
  }

  let res;
  try {
    res = await fetch(servidorUrl + ruta, {
      ...opciones,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        ...(opciones.headers || {})
      },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (e) {
    const causa = (e.cause && (e.cause.code || e.cause.message)) || e.message;
    let pista = '';
    if (/ECONNREFUSED/.test(causa))              pista = ' — ¿el servidor está encendido y es ese puerto?';
    else if (/EPROTO|SSL|certificate|wrong version/i.test(causa)) pista = ' — parece https:// contra un servidor http://';
    else if (/ENOTFOUND|EAI_AGAIN/.test(causa))  pista = ' — dominio/host no resuelve';
    else if (/tim|abort/i.test(causa))           pista = ' — no respondió a tiempo';
    const err = new Error(`no se pudo conectar a ${servidorUrl}${ruta} (${causa})${pista}`);
    err.red = true;
    throw err;
  }

  const texto = await res.text();
  let cuerpo = null;
  try { cuerpo = texto ? JSON.parse(texto) : null; } catch { cuerpo = texto; }

  if (!res.ok) {
    const err = new Error(`API ${ruta} respondió ${res.status}`);
    err.status = res.status;
    err.cuerpo = cuerpo;
    throw err;
  }
  return cuerpo;
}

module.exports = {
  salud:       ()        => req('/api/health'),
  nodo:        ()        => req('/api/nodo'),
  push:        (eventos) => req('/api/push', { method: 'POST', body: JSON.stringify({ eventos }) }),
  pull:        (payload) => req('/api/pull', { method: 'POST', body: JSON.stringify(payload) }),
  // fallbacks contra servidores viejos
  sync:        (payload) => req('/api/sync', { method: 'POST', body: JSON.stringify(payload) }),
  pushEventos: (eventos) => req('/api/sync/eventos', { method: 'POST', body: JSON.stringify({ eventos }) })
};
