# sincronizador-cliente

Servicio local (Node.js) que corre en cada **nodo** (la PC/servidor que tiene el MySQL de Maverick).
En bucle:

1. **Push** — lee los cambios que los triggers dejaron en `sync_control` y los manda al servidor.
2. **Pull** — pide al servidor los cambios de los demás nodos de la misma empresa y los aplica
   localmente (idempotente, con anti-eco `@sync_nodo`).

El servidor (proyecto `sincronizador`, en la nube) es el hub. Contrato HTTP: `../sincronizador/docs/PROTOCOLO.md`.

## Requisitos

- Node.js ≥ 18 (usa `fetch` nativo).
- Acceso de red a la BD MySQL local y al servidor sincronizador.

## Puesta en marcha

```bash
npm install
copy tablas.example.json tablas.json   # QUÉ tablas se sincronizan (editar)
npm start
```

Toda la configuración se hace en el panel **http://127.0.0.1:3010**:
1. **Base de datos local** → host / usuario / contraseña / base → "Guardar y conectar".
2. **Servidor sincronizador** → URL + la API key que te dio el servidor → "Guardar y probar".
3. **Rango de IDs** → letra/sucursal + rango [desde, hasta) → "Aplicar rango".
4. **Triggers** → "Crear / recrear triggers".

### Rango de IDs (secuencias) — réplica de `frmTriggers` de Maverick

Cada nodo genera sus PKs nuevas en un rango propio (NODO-A: 1–1 000 000, NODO-B: 1 000 001–2 000 000…)
para que **no choquen** al sincronizar. "Aplicar rango":
- crea el trigger `before_insert_<tabla>` — si la PK entra `NULL` o `0`, la toma de `id_secuencias`
  (`sucursal` + `entidad`) y avanza el contador;
- siembra `id_secuencias` con el `MAX(pk)` que ya exista dentro del rango;
- guarda `LETRA` / `RANGO_INICIO` / `RANGO_FIN` en la tabla `local`.

**Los rangos de nodos distintos NO deben solaparse** (lo controlas tú). Los inserts que llegan por
pull ya traen su PK → el trigger no los toca.

## Configuración

| Archivo | Qué lleva | Se versiona |
|---|---|---|
| `config.json` | comportamiento: `puerto` (3010), `intervaloSegundos`, `lotePush`, `lotePull`, `log`. Opcional (usa `config.example.json` si falta). | no |
| `tablas.json` | **qué tablas se sincronizan** (ver abajo). | no |
| `state/ajustes.json` | credenciales de BD + URL + api_key, tal como quedaron desde el panel. No editar a mano. | no |
| `state/estado.json` | lo maneja el servicio: cursor, código de nodo. No editar. | no |

### `tablas.json`

```jsonc
{
  "modo": "lista",                 // "lista" = SOLO las de "incluir"
  "excluir": ["anchos"],           // siempre gana, en cualquier modo
  "incluir": [
    { "tabla": "facturaenc", "pk": "facturaencid" },
    { "tabla": "facturadet", "pk": "facturadetid" },
    "clientes"                     // pk opcional: si falta se detecta sola
  ]
}
```

- `modo: "lista"` → solo se sincronizan las de `incluir`. Es lo recomendado (hay tablas locales
  que no se respaldan). `tablas.example.json` ya trae la lista completa de Maverick; copia,
  y borra las que no quieras.
- `modo: "auto"` → todas las tablas con PK de una sola columna, **menos** `excluir`.

Tras cambiar `tablas.json` o el esquema de la base: pulsa "Crear / recrear triggers" en el panel
o corre `npm run triggers`.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm start` | corre el servicio |
| `npm run dev` | igual, con reinicio al guardar |
| `npm run triggers` | recrea **todos** los triggers (tras cambio de esquema o de `tablas.json`) |

## Panel (http://127.0.0.1:3010)

Solo accesible desde esa PC. Muestra estado (nodo, cursor, pendientes, selección de tablas) y permite:
- configurar URL + API key del servidor y probar la conexión;
- crear/recrear los triggers.

`GET /estado` devuelve el mismo estado en JSON (para monitoreo).

## Re-seed (nodo muy atrasado)

Si un nodo estuvo apagado más que la retención del servidor (30 días por defecto), el servidor
ya podó eventos que ese nodo necesitaba. El panel muestra **⚠ Re-seed requerido** y la
sincronización de entrada se detiene (el push sigue). Para recuperarlo:

1. En un nodo que esté **al día**, volcá las tablas sincronizadas:
   `mysqldump -u root -p <base_al_dia> > seed.sql` (o solo las tablas de `tablas.json`).
2. Cargá ese volcado en la base de **este** nodo: `mysql -u root -p <base_local> < seed.sql`.
3. En el panel, sección **Re-seed requerido**, confirmá "Ya resembré — fijar cursor"
   (el valor sugerido es el `seq` actual del servidor). Eso pone el cursor local a ese número
   y reanuda la sincronización.

Para evitarlo: no dejar nodos `activo = 1` en el servidor si ya no se usan (bloquean la poda).

## Como servicio de Windows (NSSM)

```bat
nssm install SincronizadorCliente "C:\Program Files\nodejs\node.exe" "C:\ruta\sincronizadorcliente\app.js"
nssm set SincronizadorCliente AppDirectory "C:\ruta\sincronizadorcliente"
nssm set SincronizadorCliente AppStdout "C:\ruta\sincronizadorcliente\state\servicio.out.log"
nssm set SincronizadorCliente AppStderr "C:\ruta\sincronizadorcliente\state\servicio.err.log"
nssm start SincronizadorCliente
```

## Estado

Sincronización bidireccional funcionando (push + pull + anti-eco, probado con 2 nodos).
Si el servidor es viejo y no tiene `POST /api/sync`, el servicio detecta el `404` y cae a
modo solo-push automáticamente.
