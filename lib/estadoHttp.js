const http = require('http');
const log      = require('./log');
const estado   = require('./estado');
const ajustes  = require('./ajustes');
const db       = require('./db');
const esquema    = require('./esquema');
const secuencias = require('./secuencias');
const preparar   = require('./preparar');
const seleccionTablas = require('./seleccionTablas');
const { puerto } = require('../config');
const { contarPendientes, contarEstados, resumen, refrescarNodo, fijarCursor } = require('./sincronizar');

// Panel local (solo 127.0.0.1) para configurar BD + servidor y crear/recrear triggers.
//   GET  /            panel HTML
//   GET  /estado      JSON de estado
//   POST /bd          { host, port, user, password, database }  -> guarda + reconecta
//   POST /probar-bd   prueba una config de BD sin guardarla
//   POST /servidor    { servidorUrl, apiKey }  -> guarda + prueba
//   POST /triggers    (re)crea todos los triggers

let recreandoTriggers = false;

function leerJson(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end',  () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj, null, 2));
}

async function estadoActual(refs) {
  const a   = ajustes.get();
  let sel;
  try { sel = seleccionTablas.cargar(); }
  catch (e) { sel = { archivo: 'FALTA tablas.json', modo: '—', incluir: [], excluir: [] }; }

  let pendientes = null, estados = null, secParams = { letra: '', desde: '', hasta: '' };
  if (db.configurada()) {
    try { pendientes = await contarPendientes(db.getPool()); } catch { /* BD mal configurada */ }
    try { estados = await contarEstados(db.getPool()); } catch { /* idem */ }
    try { secParams = await secuencias.leerParametrosLocal(db.getPool()); } catch { /* idem */ }
  }

  return {
    ok: true,
    corriendo:   refs.corriendo(),
    nodo:        estado.get().nodoCodigo,
    empresa:     estado.get().empresa || null,
    cursor:      estado.get().cursor || 0,
    ultimaSync:  estado.get().ultimaSync,
    pendientes,
    estados,
    reseedRequerido: Boolean(estado.get().reseedRequerido),
    seqActual:       estado.get().seqActual || 0,
    empresaPausada:  Boolean(estado.get().empresaPausada),
    empresaError:    estado.get().empresaError || null,
    saltados:        estado.get().saltados || [],
    secuencias:      secParams,
    bd: {
      configurada: db.configurada(),
      host: a.db.host, port: a.db.port, user: a.db.user, database: a.db.database,
      passwordPuesta: Boolean(a.db.password)
    },
    servidor: {
      configurado: ajustes.servidorConfigurado(),
      url: a.servidorUrl,
      apiKeyPuesta: Boolean(a.apiKey)
    },
    tablas: {
      archivo: sel.archivo,
      modo:    sel.modo,
      incluir: sel.incluir.length,
      excluir: sel.excluir.length
    },
    ultimoCiclo: resumen()
  };
}

function iniciar(refs) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = req.url.split('?')[0];

      if (req.method === 'GET' && (url === '/' || url === '/panel')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGINA);
        return;
      }

      if (req.method === 'GET' && (url === '/estado' || url === '/salud')) {
        return json(res, 200, await estadoActual(refs));
      }

      if (req.method === 'POST' && url === '/probar-bd') {
        const body = await leerJson(req);
        const actual = ajustes.get().db;
        const conf = { ...actual, ...body.db, password: (body.db && body.db.password) || actual.password };
        return json(res, 200, await db.probar(conf));
      }

      if (req.method === 'POST' && url === '/bd') {
        const body = await leerJson(req);
        ajustes.guardar({ db: body.db || body });
        await db.recrear();
        preparar.reset();
        let prep = { ok: false };
        try { prep = await preparar.asegurar(); }
        catch (e) { prep = { ok: false, error: e.message }; }
        return json(res, 200, { guardado: true, preparado: prep, estado: await estadoActual(refs) });
      }

      if (req.method === 'POST' && url === '/servidor') {
        const body = await leerJson(req);
        ajustes.guardar({ servidorUrl: body.servidorUrl, apiKey: body.apiKey });
        preparar.reset();
        let prueba = { ok: false };
        try {
          const n = await refrescarNodo();
          prueba = {
            ok: true,
            nodo: n && n.nodo && n.nodo.codigo,
            empresa: (n && n.empresa) || null,
            empresa_id: n && n.empresa_id
          };
          if (db.configurada()) await preparar.asegurar();
        } catch (e) {
          prueba = { ok: false, error: e.message };
        }
        return json(res, 200, { guardado: true, prueba, estado: await estadoActual(refs) });
      }

      if (req.method === 'POST' && url === '/fijar-cursor') {
        const body = await leerJson(req);
        const v = fijarCursor(body.cursor);
        log.warn(`cursor fijado a mano: ${v}`);
        return json(res, 200, { ok: true, cursor: v, estado: await estadoActual(refs) });
      }

      if (req.method === 'POST' && url === '/secuencias') {
        if (!db.configurada()) return json(res, 400, { ok: false, error: 'configura la base de datos primero' });
        const body = await leerJson(req);
        try {
          const r = await secuencias.aplicar(db.getPool(), {
            letra: body.letra, desde: body.desde, hasta: body.hasta
          });
          return json(res, 200, { ok: true, ...r, mensaje: `Rango '${r.sucursal}' aplicado en ${r.tablas} tablas` });
        } catch (e) {
          return json(res, 400, { ok: false, error: e.message });
        }
      }

      if (req.method === 'POST' && url === '/triggers') {
        if (!db.configurada()) return json(res, 400, { ok: false, error: 'configura la base de datos primero' });
        if (recreandoTriggers) return json(res, 409, { ok: false, error: 'ya se está recreando' });
        recreandoTriggers = true;
        try {
          const r = await preparar.asegurar({ forzarTriggers: true });
          return json(res, 200, { ok: true, tablas: r.tablas, mensaje: `Triggers recreados en ${r.tablas} tablas` });
        } catch (e) {
          log.error('recrear triggers: ' + (e.stack || e.message));
          return json(res, 500, { ok: false, error: e.message });
        } finally {
          recreandoTriggers = false;
        }
      }

      json(res, 404, { error: 'ruta no encontrada' });
    } catch (e) {
      log.error('panel: ' + (e.stack || e.message));
      json(res, 500, { error: e.message });
    }
  });

  server.on('error', (e) => log.error('panel :' + puerto + ' -> ' + e.message));
  server.listen(puerto, '127.0.0.1', () => log.info(`panel en http://127.0.0.1:${puerto}`));
  return server;
}

const PAGINA = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sincronizador cliente</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; max-width: 640px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #888; margin: 0 0 20px; }
  fieldset { border: 1px solid #8884; border-radius: 8px; margin: 0 0 16px; padding: 14px 16px; }
  legend { font-weight: 600; padding: 0 6px; }
  label { display: block; margin: 10px 0 4px; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; padding: 7px 9px; border: 1px solid #8886; border-radius: 6px; font: inherit; background: #0000; }
  .row2 { display: grid; grid-template-columns: 1fr 120px; gap: 10px; }
  button { font: inherit; padding: 7px 14px; border: 1px solid #8886; border-radius: 6px; background: #8881; cursor: pointer; }
  button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  button:disabled { opacity: .5; cursor: default; }
  .fila { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; }
  .kv div:nth-child(odd) { color: #888; }
  .hint { color: #888; font-size: 12px; margin: 4px 0 0; }
  #msg {
    position: fixed; left: 16px; right: 16px; bottom: 16px; max-width: 620px; margin: 0 auto;
    padding: 10px 12px; border-radius: 8px; white-space: pre-wrap; display: none;
    align-items: flex-start; gap: 10px; box-shadow: 0 4px 20px #0004;
    opacity: 0; transition: opacity .25s;
  }
  #msg.show { opacity: 1; }
  #msg.ok  { background: #16a34a; color: #fff; }
  #msg.err { background: #dc2626; color: #fff; }
  #msg .txt { flex: 1; }
  #msg .x { border: 0; background: #0000; color: inherit; font-size: 18px; line-height: 1; padding: 0 2px; opacity: .8; }
  .mono { font-family: ui-monospace, monospace; }
  small { color: #888; font-weight: 400; }
  #reseed { display: none; border: 1px solid #dc2626; background: #dc262618; border-radius: 8px; padding: 12px 14px; margin: 0 0 16px; }
  #reseed h3 { margin: 0 0 6px; color: #dc2626; font-size: 15px; }
</style></head><body>
<h1>Sincronizador cliente</h1>
<p class="sub">Servicio local del nodo. Este panel solo se ve desde esta PC.</p>

<div id="reseed">
  <h3>⚠ Re-seed requerido</h3>
  <p style="margin:0 0 8px">Este nodo quedó demasiado atrás y el servidor ya podó eventos que necesitaba.
  La sincronización de <b>entrada</b> está detenida (el push sigue funcionando).</p>
  <p style="margin:0 0 8px">Pasos: (1) copiá la base de datos de un nodo que esté al día a este equipo
  (mysqldump / restore), (2) confirmá abajo para fijar el cursor al día.</p>
  <div class="fila">
    <input id="seedcursor" style="max-width:120px" placeholder="cursor">
    <button class="primary" id="btnFijar">Ya resembré — fijar cursor</button>
  </div>
</div>

<fieldset>
  <legend>Estado</legend>
  <div class="kv" id="estado"><div>cargando…</div><div></div></div>
</fieldset>

<fieldset>
  <legend>Base de datos local</legend>
  <div class="row2">
    <div><label for="dbhost">Host</label><input id="dbhost" placeholder="127.0.0.1" autocomplete="off"></div>
    <div><label for="dbport">Puerto</label><input id="dbport" placeholder="3306" autocomplete="off"></div>
  </div>
  <label for="dbuser">Usuario</label><input id="dbuser" autocomplete="off">
  <label for="dbpass">Contraseña <small>(dejar vacío = no cambiar)</small></label>
  <input id="dbpass" type="password" autocomplete="off">
  <label for="dbname">Base de datos</label><input id="dbname" placeholder="masterchef" autocomplete="off">
  <div class="fila">
    <button class="primary" id="btnBd">Guardar y conectar</button>
    <button id="btnProbarBd">Probar conexión</button>
  </div>
</fieldset>

<fieldset>
  <legend>Servidor sincronizador</legend>
  <label for="url">URL del servidor</label>
  <input id="url" placeholder="http://IP-DEL-SERVIDOR:3000" autocomplete="off">
  <p class="hint">La del proyecto <span class="mono">sincronizador</span> (no este panel). En local suele ser <span class="mono">http://localhost:3000</span>. Usa <span class="mono">https://</span> solo si el servidor tiene certificado.</p>
  <label for="key">API key del nodo</label>
  <input id="key" type="password" placeholder="pega aquí la api_key que te dio el servidor" autocomplete="off">
  <label style="font-weight:400"><input type="checkbox" id="verkey" style="width:auto"> ver</label>
  <div class="fila">
    <button class="primary" id="btnSrv">Guardar y probar</button>
  </div>
</fieldset>

<fieldset>
  <legend>Rango de IDs (secuencias)</legend>
  <p class="hint">Cada nodo genera sus PKs en un rango propio, para que no choquen. Crea el trigger <span class="mono">before_insert_&lt;tabla&gt;</span> y siembra <span class="mono">id_secuencias</span>. Los rangos de nodos distintos NO deben solaparse.</p>
  <div class="row2">
    <div><label for="secletra">Letra / sucursal</label><input id="secletra" maxlength="2" placeholder="A" autocomplete="off"></div>
    <div></div>
  </div>
  <div class="row2">
    <div><label for="secdesde">Rango desde</label><input id="secdesde" placeholder="1" autocomplete="off"></div>
    <div><label for="sechasta">Rango hasta</label><input id="sechasta" placeholder="1000000" autocomplete="off"></div>
  </div>
  <div class="fila"><button id="btnSecuencias">Aplicar rango</button></div>
</fieldset>

<fieldset>
  <legend>Triggers</legend>
  <p style="margin:.2em 0 0;color:#888">Crea/recrea los triggers que capturan los cambios en <span class="mono">sync_control</span>, según <span class="mono">tablas.json</span>. Correr al instalar y cada vez que cambie el esquema o la lista.</p>
  <div class="fila"><button id="btnTriggers">Crear / recrear triggers</button></div>
</fieldset>

<div id="msg"><span class="txt"></span><button class="x" title="cerrar">&times;</button></div>

<script>
const $ = s => document.querySelector(s);
const post = async (r, b) => (await fetch(r, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(b||{}) })).json();
const foco = () => document.activeElement;

let msgTimer;
function ocultarMsg() {
  const m = $('#msg');
  m.classList.remove('show');
  setTimeout(() => { if (!m.classList.contains('show')) m.style.display = 'none'; }, 260);
}
function msg(t, ok, ms) {
  const m = $('#msg');
  m.querySelector('.txt').textContent = t;
  m.className = ok ? 'ok' : 'err';
  m.style.display = 'flex';
  void m.offsetWidth;            // reinicia la transición
  m.classList.add('show');
  clearTimeout(msgTimer);
  const dur = ms ?? (ok ? 5000 : 11000);
  if (dur) msgTimer = setTimeout(ocultarMsg, dur);
}
$('#msg .x').onclick = ocultarMsg;

$('#verkey').onchange = e => $('#key').type = e.target.checked ? 'text' : 'password';

async function cargarEstado() {
  try {
    const s = await (await fetch('/estado')).json();
    const rs = $('#reseed');
    rs.style.display = s.reseedRequerido ? 'block' : 'none';
    if (s.reseedRequerido && !$('#seedcursor').value) $('#seedcursor').value = s.seqActual || '';

    const est = s.estados || {};
    $('#estado').innerHTML = [
      ['nodo', s.nodo || '—'],
      ['empresa', s.empresa || '—' + (s.empresaPausada ? '  ⚠ PAUSADA en el servidor' : '')],
      ['cursor', s.cursor + (s.reseedRequerido ? '  ⚠ re-seed requerido' : '')],
      ['outbox', 'pend ' + (est.PENDIENTE||0) + ' · enviado ' + (est.ENVIADO||0) + ' · aplicado ' + (est.APLICADO||0) + ' · error ' + (est.ERROR||0)],
      ['pendientes por enviar', s.pendientes ?? '—'],
      ['eventos saltados (pull)', (s.saltados && s.saltados.length) ? (s.saltados.length + ' — ' + s.saltados.map(x=>'seq '+x.seq+' '+x.tabla).join(', ')) : '0'],
      ['última sincronización', s.ultimaSync || '—'],
      ['base de datos', s.bd.configurada ? 'ok' : 'sin configurar'],
      ['servidor', s.servidor.configurado ? 'ok' : 'sin configurar'],
      ['corriendo', s.corriendo ? 'sí' : 'no'],
      ['tablas', s.tablas.modo + ' · ' + s.tablas.archivo + ' · ' + s.tablas.incluir + ' incl / ' + s.tablas.excluir + ' excl'],
      ['rango de IDs', (s.secuencias && s.secuencias.letra) ? ("'" + s.secuencias.letra + "'  [" + s.secuencias.desde + ', ' + s.secuencias.hasta + ')') : 'sin configurar'],
    ].map(([k,v]) => '<div>'+k+'</div><div class="mono">'+v+'</div>').join('');
    const set = (id, val) => { if (foco() !== $(id) && val != null && val !== '') $(id).value = val; };
    set('#dbhost', s.bd.host); set('#dbport', s.bd.port); set('#dbuser', s.bd.user); set('#dbname', s.bd.database);
    set('#url', s.servidor.url);
    if (s.secuencias) { set('#secletra', s.secuencias.letra); set('#secdesde', s.secuencias.desde); set('#sechasta', s.secuencias.hasta); }
    if (s.bd.passwordPuesta && !$('#dbpass').value) $('#dbpass').placeholder = '•••••• (guardada)';
    if (s.servidor.apiKeyPuesta && !$('#key').value) $('#key').placeholder = '•••••• (guardada)';
  } catch { $('#estado').innerHTML = '<div>servicio no responde</div><div></div>'; }
}

function dbForm() {
  return { host: $('#dbhost').value, port: $('#dbport').value, user: $('#dbuser').value,
           password: $('#dbpass').value, database: $('#dbname').value };
}

$('#btnBd').onclick = async () => {
  const b = $('#btnBd'); b.disabled = true;
  try {
    const r = await post('/bd', { db: dbForm() });
    if (r.preparado && r.preparado.ok) msg('BD conectada. ' + r.preparado.tablas + ' tablas listas para triggers.', true);
    else msg('Guardado, pero: ' + (r.preparado && (r.preparado.error || r.preparado.motivo) || '?'), false);
    $('#dbpass').value = '';
    cargarEstado();
  } catch (e) { msg('Error: ' + e.message, false); }
  b.disabled = false;
};

$('#btnProbarBd').onclick = async () => {
  const b = $('#btnProbarBd'); b.disabled = true;
  try {
    const r = await post('/probar-bd', { db: dbForm() });
    msg(r.ok ? 'Conecta bien a la base de datos.' : ('No conecta: ' + r.error), r.ok);
  } catch (e) { msg('Error: ' + e.message, false); }
  b.disabled = false;
};

$('#btnSrv').onclick = async () => {
  const u = $('#url').value.trim();
  const aviso = /:3010(\\/|$)/.test(u) ? 'apunta al puerto 3010, que es el de ESTE panel, no el del servidor (suele ser 3000).'
    : /^https:\\/\\/(localhost|127\\.0\\.0\\.1)/.test(u) ? 'usa https:// contra localhost; el servidor local casi siempre es http://.'
    : '';
  if (aviso && !confirm('La URL ' + aviso + '\\n\\n¿Guardar de todas formas?')) return;

  const b = $('#btnSrv'); b.disabled = true;
  try {
    const r = await post('/servidor', { servidorUrl: u, apiKey: $('#key').value });
    if (r.prueba && r.prueba.ok) {
      const emp = r.prueba.empresa || ('empresa ' + r.prueba.empresa_id);
      msg('Nodo agregado: ' + r.prueba.nodo + ' — ' + emp + '.', true);
    } else msg('Se guardó la URL/key, pero no conectó:\\n' + (r.prueba && r.prueba.error || '?'), false);
    $('#key').value = '';
    cargarEstado();
  } catch (e) { msg('Error: ' + e.message, false); }
  b.disabled = false;
};

$('#btnFijar').onclick = async () => {
  if (!confirm('Esto asume que la base de datos de este nodo YA está al día (la copiaste de otro nodo). ¿Continuar?')) return;
  const b = $('#btnFijar'); b.disabled = true;
  try {
    const r = await post('/fijar-cursor', { cursor: $('#seedcursor').value });
    msg('Cursor fijado a ' + r.cursor + '. La sincronización se reanuda.', true);
    cargarEstado();
  } catch (e) { msg('Error: ' + e.message, false); }
  b.disabled = false;
};

$('#btnSecuencias').onclick = async () => {
  if (!confirm('Aplicar el rango de IDs: crea/recrea el trigger before_insert_ de cada tabla y siembra id_secuencias. ¿Continuar?')) return;
  const b = $('#btnSecuencias'); b.disabled = true; b.textContent = 'Procesando…';
  try {
    const r = await post('/secuencias', { letra: $('#secletra').value, desde: $('#secdesde').value, hasta: $('#sechasta').value });
    msg(r.ok ? (r.mensaje + (r.huerfanos ? ' · ' + r.huerfanos + ' huérfanos borrados' : '')) : ('Error: ' + r.error), r.ok);
    cargarEstado();
  } catch (e) { msg('Error: ' + e.message, false); }
  b.disabled = false; b.textContent = 'Aplicar rango';
};

$('#btnTriggers').onclick = async () => {
  if (!confirm('Recrear todos los triggers de sincronización. Puede tardar unos segundos. ¿Continuar?')) return;
  const b = $('#btnTriggers'); b.disabled = true; b.textContent = 'Procesando…';
  try {
    const r = await post('/triggers');
    msg(r.ok ? r.mensaje : ('Error: ' + r.error), r.ok);
  } catch (e) { msg('Error: ' + e.message, false); }
  b.disabled = false; b.textContent = 'Crear / recrear triggers';
};

cargarEstado();
setInterval(cargarEstado, 15000);
</script>
</body></html>`;

module.exports = { iniciar };
