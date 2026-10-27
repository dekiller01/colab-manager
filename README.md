# Colab Manager (`colabctl`)

Administrador **asistido** de tareas de Google Colab, pensado para usarse **solo desde un teléfono Android con Termux** (sin PC).
Sin dependencias externas: únicamente Node.js (≥ 18). Python solo se ejecuta *dentro de Colab* (y, opcionalmente, en las pruebas locales).

> **Lo más importante, dicho sin rodeos**
> Google no ofrece una API pública para iniciar, detener o consultar sesiones de Colab de una cuenta gratuita.
> Por eso `colabctl` **no inicia Colab por usted**. Lo que sí hace es: llevar el registro de sus tareas, generar notebooks listos para abrir,
> sincronizar estado y resultados por un canal autorizado por usted (Drive vía `rclone`, GitHub o una carpeta), vigilar si una tarea
> dejó de dar señales, y ayudarle a reintentar o reanudar desde puntos de recuperación.
> Detalles y fuentes en [`docs/LIMITES-GOOGLE.md`](docs/LIMITES-GOOGLE.md).

---

## 1. Cómo funciona

```
 TERMUX (su teléfono)                         GOOGLE COLAB (nube)
┌───────────────────────────┐   notebook    ┌────────────────────────────┐
│ colabctl                  │ ───────────►  │ Usted abre el .ipynb y     │
│  · registro de tareas     │  (Drive/GitHub│ pulsa "Ejecutar todo"      │
│  · generador de notebooks │   o archivo)  │  · valida configuración    │
│  · monitor / recuperación │               │  · guarda status.json,     │
│  · API local (Dekiller AI)│ ◄───────────  │    checkpoint.json,        │
└───────────────────────────┘  colabctl sync│    events.jsonl, result/   │
        ▲ rclone / carpeta / git            │    en Drive                │
        └───────── canal que usted autoriza └────────────────────────────┘
```

* Termux nunca recibe contraseñas ni cookies de Google. El acceso a Drive lo autoriza usted una vez con OAuth en `rclone`.
* Si Colab se desconecta, el administrador sigue funcionando: la tarea queda marcada como interrumpida y puede reanudarse.
* Cada tarea tiene un identificador `t-xxxxxxxx`; en los comandos basta un prefijo único (`t-1a2`).

## 2. Instalación desde cero en Android (Termux)

1. Instale **Termux desde F-Droid** (la versión de Google Play está obsoleta): <https://f-droid.org/packages/com.termux/>.
2. Descargue `colab-manager-v0.1.0.zip` al teléfono (carpeta *Descargas*).
3. En Termux:

```sh
termux-setup-storage                       # acepte el permiso de archivos
pkg update -y && pkg install -y unzip
unzip ~/storage/downloads/colab-manager-v0.1.0.zip -d ~
bash ~/colab-manager/scripts/install-termux.sh
```

El script instala `nodejs-lts git tar zip unzip` (y, si usted lo acepta, `rclone` y `python`), crea el comando `colabctl`,
inicializa `~/.colab-manager` y **ejecuta las pruebas**. Es seguro repetirlo.

Comprobación:

```sh
colabctl status
colabctl doctor
```

> No hay carpetas que crear a mano: los datos viven en `~/.colab-manager/` (se crean solos) y el código en `~/colab-manager/`.
> Todo el código está dentro del ZIP; léalo con `cat`, `less` o cualquier editor de Termux (`pkg install nano`).

## 3. Configuración inicial

`colabctl init` crea `~/.colab-manager/config.json` con valores seguros (ver `config/config.example.json`).
**Nunca escriba tokens ni contraseñas ahí**: `colabctl` rechaza claves que parezcan secretos.

| Clave | Significado |
|---|---|
| `provider` | `manual` (flujo asistido). `colab-api` y `colab-enterprise` existen pero **devuelven "no implementado"** (ver límites). |
| `channel` | Cómo se mueven archivos entre Termux y Colab: `none`, `folder`, `rclone`, `github`. |
| `colab.storageMode` | `drive` (persistente, recomendado) o `local` (se pierde al cerrar la sesión). |
| `colab.driveFolder` | Carpeta de Drive donde Colab escribe (`MyDrive/ColabManager`). |
| `limits.*` | Reintentos, tareas simultáneas, tiempos del monitor, tamaños máximos, límite de la API. |

Edite con `nano ~/.colab-manager/config.json` y compruebe con `colabctl config`.

### Canal de sincronización (elija uno)

**A) `rclone` + Google Drive (recomendado)**

```sh
pkg install rclone
rclone config          # n) nuevo → nombre: gdrive → tipo: drive → scope: 1 (acceso completo) → autenticación en el navegador del teléfono
```

```json
"channel": { "type": "rclone", "remote": "gdrive", "timeoutSec": 120 }
```

Notas honestas: (1) con el alcance restringido `drive.file`, rclone **no ve** los archivos que crea Colab, por eso hace falta acceso completo;
puede limitarlo a la carpeta con `root_folder_id` en la configuración de rclone. (2) La autenticación en el propio teléfono depende
de que el navegador pueda abrir el enlace local que rclone muestra; este flujo **no se pudo probar aquí**.
(3) `colabctl` nunca lee ni guarda el token de rclone.

**B) `folder`** — una carpeta local que usted mantenga sincronizada con la de Drive (Syncthing, FolderSync…) o donde copie a mano los archivos:

```json
"channel": { "type": "folder", "path": "/data/data/com.termux/files/home/storage/shared/ColabManager" }
```

**C) `github`** — distribuye los notebooks (enlace directo `colab.research.google.com/github/...`) y combina un canal de resultados:

```json
"channel": { "type": "github", "repo": "usuario/mi-repo-privado", "branch": "main", "dir": "notebooks",
             "results": { "type": "rclone", "remote": "gdrive" } }
```

Use un repositorio **privado** (el notebook contiene la configuración de la tarea). `git` debe estar autenticado por usted (`pkg install gh && gh auth login`).

**D) `none`** — sin canal: copie el `.ipynb` a Colab a mano y use `colabctl mark` para informar el estado real.

## 4. Primer uso (10 minutos, sin gastar nada)

```sh
colabctl add "prueba" --config '{"steps":30,"sleepSec":2,"checkpointEvery":5}' --prepare
colabctl list
colabctl run t-xxxxxxxx          # prepara y le dice qué hacer; NO inicia Colab
```

Después:

1. Con canal: `colabctl sync` sube el notebook y le da el enlace de Colab (rclone/GitHub). Sin canal: súbalo en <https://colab.research.google.com> → *Archivo → Subir cuaderno* (el archivo está en `~/.colab-manager/notebooks/`; cópielo a *Descargas* con `cp`).
2. En Colab: *Entorno de ejecución → Ejecutar todo*, autorice Drive.
3. De vuelta en Termux: `colabctl sync`, `colabctl status`, `colabctl logs t-xxx`.

Cuando llegue el primer latido, la tarea deja la fase `esperando inicio` y pasa a `activa`; al terminar queda `completed` y los resultados se descargan en `~/.colab-manager/sync/t-xxx/result/`.

> Nota sobre estados: `run` pone la tarea en `running` con fase *esperando inicio* para **evitar duplicados** (no se puede pedir dos veces lo mismo).
> Eso **no significa** que Colab esté ejecutándola: lo confirma solo el primer latido sincronizado.

Probar la recuperación: cree la tarea con `"failAtStep":4` (falla a propósito solo en el intento 1), ejecútela en Colab, `colabctl sync`, luego `colabctl resume t-xxx --run`.

## 5. Comandos

| Comando | Qué hace |
|---|---|
| `colabctl status` | Estado del administrador, canal, conteo por estado, tareas en ejecución y su veredicto del monitor. |
| `colabctl add "nombre" [--type T] [--config JSON] [--script F.py] [--prepare]` | Registra una tarea. Rechaza duplicados activos idénticos (`--allow-duplicate`). |
| `colabctl list [--state S]` | Lista tareas (`--json` para scripts). |
| `colabctl notebook ID` | Genera el `.ipynb` (estado `prepared`). |
| `colabctl run ID [--force]` | Solicita ejecución (modo asistido). `--force` pide confirmación. |
| `colabctl logs ID [--tail N]` | Eventos locales + los del notebook (tras `sync`). Los secretos se redactan. |
| `colabctl cancel ID` | Marca cancelada y escribe `cancel.flag`; el notebook lo revisa en cada `progress()`. **No detiene Colab por sí mismo** (pide confirmación). |
| `colabctl retry ID [--run]` | Reintenta desde cero una tarea `failed`/`cancelled` (respeta `limits.maxRetries`). |
| `colabctl resume ID [--run]` | Reanuda desde el último punto de recuperación conocido. |
| `colabctl sync` | Sube notebooks y cancelaciones; trae estado, checkpoints y resultados. |
| `colabctl monitor [--sync] [--fix] [--watch --interval S]` | Evalúa tareas en ejecución; `--fix` marca las interrumpidas. |
| `colabctl mark ID ESTADO` | Informa el estado real a mano (sin canal). Solo transiciones válidas. |
| `colabctl delete ID` | Mueve a `trash/` (recuperable; confirmación). |
| `colabctl templates` · `doctor` · `config` · `init` | Tipos de tarea, diagnóstico, configuración efectiva, inicialización. |
| `colabctl backup [--out F]` · `restore F` | Copia y restauración (ver §10). |
| `colabctl serve [--port N]` | API local para Dekiller AI (requiere `COLABCTL_API_TOKEN`). |

Opciones globales: `--json`, `--yes/-y`, `--home RUTA`. Códigos de salida: `0` ok · `1` error · `2` uso/validación · `3` función no implementada o limitada.
Cualquier función no disponible lo dice y sale con código 3: nunca simula éxito.

## 6. Tipos de tarea

* `demo-counter` — cuenta pasos con checkpoints; prueba todo el flujo sin descargar nada.
* `text-batch` — procesa una lista de textos (`uppercase`, `wordcount`, `sha256`) con reanudación exacta.
* `script` — su propio Python (`def run(ctx):`), ver `examples/mi-tarea.py`.

```sh
colabctl add "cuadrados" --script examples/mi-tarea.py --config '{"n":50,"checkpointEvery":10}' --prepare
```

Los notebooks **no instalan paquetes ni descargan modelos** salvo que la tarea lo habilite con `"allowInstall": true` y una lista `requirements` validada.
Hay un notebook ya generado en `examples/ejemplo-colab.ipynb`.

## 7. Monitor y recuperación

`colabctl monitor --sync` evalúa cada tarea `running` con tres entradas: último latido, ritmo medio por paso y antigüedad de la sincronización. Veredictos:
`esperando inicio`, `NO INICIÓ`, `activa`, `lenta`, `POSIBLE DESCONEXIÓN`, `sin datos suficientes`.
Si los datos son viejos o no hay red, el veredicto es *sin datos suficientes* y **no se cambia nada** (evita falsos positivos).
Solo con `--fix` una tarea dada por interrumpida pasa a `failed` y se sugiere `resume` (si hay checkpoint) o `retry`.
En Termux: `termux-wake-lock` antes de `monitor --watch`. El monitor **no** mantiene viva ninguna sesión de Colab.

Anti-duplicados (tres capas): huella de configuración al crear, bloqueo de `run` mientras haya intento abierto, y guardia en el notebook
(rechaza ejecutarse si otra sesión escribió un latido reciente o si ese intento ya terminó).

## 8. Integración con Dekiller AI (preparada)

```sh
export COLABCTL_API_TOKEN="$(head -c 24 /dev/urandom | base64)"
colabctl serve --port 8787                 # solo 127.0.0.1
```

`Authorization: Bearer <token>`; rutas: `GET /v1/status`, `GET|POST /v1/tasks`, `GET /v1/tasks/:id`, `GET /v1/tasks/:id/logs`,
`POST /v1/tasks/:id/run`, `POST /v1/tasks/:id/cancel`, `GET /v1/tasks/:id/results[/archivo]`.
En un backend Express: `app.use('/colab', createHandler({ manager, token }))` (ver `examples/dekiller-express.js`).
Incluye comparación de token en tiempo constante, límite de cuerpo, límite de peticiones por minuto y nombres de archivo validados.
La cola persistente multiproveedor y la autenticación por usuario quedan para la fase 5 (ver hoja de ruta).

## 9. Seguridad

Validación estricta de IDs, nombres, rutas y configuración · sin shell (se usan `execFile` con argumentos separados) ·
datos recibidos de Colab tratados como no confiables · escritura atómica (`tmp` + `fsync` + `rename`) con `.bak` y recuperación ·
secretos redactados en registros y errores · config con claves tipo secreto rechazada · permisos `0700/0600` ·
confirmación en operaciones destructivas · límites de reintentos y de tareas simultáneas · `.gitignore` con secretos y datos.
Lo que **no** hace: no extrae cookies, no pide contraseñas de Google, no evade CAPTCHA ni límites de Colab, no simula actividad.

## 10. Pruebas

```sh
cd ~/colab-manager && npm test        # o: node --test tests/*.test.js
```

**Pruebas locales (pasan en este proyecto, sin Colab):** registro y persistencia, IDs, transiciones, recuperación de archivos dañados,
reintentos y duplicados, generación y sintaxis de notebooks, monitor, canales con `rclone`/`git` simulados (incluido «sin conexión»),
API HTTP, copias de seguridad, y el **runtime de Python ejecutado en una simulación local de Colab** (carpeta en lugar de Drive).

**Todavía necesitan una prueba real en Google Colab** (no verificadas): montaje de Drive y permisos, ejecución real del notebook en la VM de Colab,
comportamiento ante desconexiones reales, `rclone` con su cuenta de Drive desde Android, y enlaces `colab.research.google.com/github/...` con repositorios privados.
Si algo falla ahí, abra una tarea `demo-counter` pequeña y revise `colabctl logs`.

## 11. Problemas habituales en Termux

| Síntoma | Solución |
|---|---|
| `colabctl: command not found` | Cierre y abra Termux, o `node ~/colab-manager/colabctl.js status`; si persiste, vuelva a ejecutar el instalador. |
| `Permission denied` en `~/storage/...` | `termux-setup-storage` y acepte el permiso; reinicie Termux. |
| `pkg` falla o repositorios lentos | `termux-change-repo` y elija otro espejo; luego `pkg update`. |
| `node: not found` / versión < 18 | `pkg install nodejs-lts`. |
| El monitor se detiene al apagar la pantalla | `termux-wake-lock` y desactive la optimización de batería para Termux. |
| `rclone` pide navegador | Siga el enlace local que muestra, ábralo en el navegador del teléfono; o configure rclone en otra máquina y copie su `rclone.conf` (¡es un secreto!). |
| `Sin conexión a Google Drive` | Es normal sin red: nada se pierde ni cambia; reintente `colabctl sync`. |
| Registro dañado tras cierre inesperado | `colabctl doctor` lo recupera desde `.bak`; si no, `colabctl restore` una copia. |
| `EACCES` al crear el comando | Ejecute el instalador de nuevo; no use `sudo` (Termux no lo tiene). |

## 12. Actualizar, copia de seguridad y restauración

```sh
# Actualizar (los datos en ~/.colab-manager no se tocan; si fallan las pruebas se vuelve a la versión anterior)
bash ~/colab-manager/scripts/update.sh ~/storage/downloads/colab-manager-vNUEVA.zip

# Copia (config, tareas, notebooks y espejo de sincronización; sin secretos)
colabctl backup --out ~/storage/shared/colab-manager-$(date +%F).tar.gz

# Restaurar (valida antes; conserva lo actual como *.pre-restore-FECHA)
colabctl restore ~/storage/shared/colab-manager-2026-10-10.tar.gz
```

## 13. Estructura

```
colab-manager/
├── colabctl.js            punto de entrada (delgado)
├── cli/                   definición de comandos y salida
├── lib/                   errores, argumentos, validación, utilidades, ejecución segura
├── config/                carga/validación de configuración + config.example.json
├── jobs/                  gestor de tareas, estados, esquema, incorporación de estado remoto
├── storage/               escritura atómica, bloqueos, almacén de tareas, backup/restore
├── logs/                  registro y redacción de secretos
├── notebooks/             generador de .ipynb
├── templates/             runtime.py (corre en Colab) y tipos de tarea
├── providers/             ejecución (manual, colab-api*, colab-enterprise*) y canales (folder, rclone, github)
├── monitor/               evaluación de salud de tareas
├── recovery/              reparación del almacén y plan de reintento/reanudación
├── integrations/dekiller/ manejador HTTP para Node/Express
├── examples/              notebook de ejemplo, script de usuario, servidor Express
├── scripts/               instalación, actualización, ZIP, notebook de ejemplo
├── tests/                 pruebas automáticas (node:test)
└── docs/                  ARQUITECTURA, LIMITES-GOOGLE, ROADMAP
```

(`*` = declarado pero no implementado: responde «no implementado» con el motivo.)
Más: [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) · [`docs/LIMITES-GOOGLE.md`](docs/LIMITES-GOOGLE.md) · [`docs/ROADMAP.md`](docs/ROADMAP.md).

Licencia MIT.
