# Arquitectura

## Decisión: Node.js para el administrador, Python solo dentro de Colab

| Lenguaje | Dónde corre | Responsabilidad | Por qué |
|---|---|---|---|
| **Node.js** (sin dependencias) | Termux | CLI, registro, estados, notebooks, canales, monitor, API | Mismo stack que Dekiller AI (Node/Express); `node:test`, `fs`, `http`, `crypto` incluidos; instala con un solo `pkg install`. |
| **Python** (solo biblioteca estándar) | Colab (`templates/runtime.py`) | Validar configuración, estado y latidos, checkpoints, reanudación, cancelación cooperativa | Es el lenguaje de Colab; se incrusta en el notebook, sin instalar nada. |

No hay puente Node↔Python local: la frontera es el **protocolo de archivos** abajo.

## Capas y módulos

| Capa | Módulo | Responsabilidad |
|---|---|---|
| Administrador local | `colabctl.js`, `cli/` | Interpretar comandos, confirmar operaciones destructivas, imprimir (texto o `--json`), códigos de salida. |
| Planificación y registro | `jobs/` (`manager`, `states`, `schema`, `ingest`), `logs/` | Ciclo de vida de tareas, máquina de estados, límites, anti-duplicados, eventos redactados. |
| Notebooks | `notebooks/`, `templates/` | Generar `.ipynb` (nbformat 4); plantillas de tarea y runtime. Configuración incrustada como literal de cadena (sin interpolación de código). |
| Almacenamiento | `storage/` | Escritura atómica, bloqueo con detección de bloqueos viejos, lectura con recuperación `.bak` y cuarentena, backup/restore. |
| Comunicación | `providers/channels/` (`folder`, `rclone`, `github`) | Mover archivos entre Termux y el almacén de Colab. Intercambiables. |
| Ejecución | `providers/index.js` | `manual` (asistido); `colab-api` y `colab-enterprise` declarados, «no implementado». |
| Monitor | `monitor/` | Función pura `evaluate()`; el gestor decide si actuar. |
| Recuperación | `recovery/` | Reparar el almacén; planificar `retry`/`resume`. |
| Integración | `integrations/dekiller/` | Manejador HTTP estándar (`http` o middleware Express). |

## Protocolo de archivos Termux ⇄ Colab

Colab escribe en `MyDrive/<driveFolder>/<id>/`; `sync` los copia a `~/.colab-manager/sync/<id>/`:

| Archivo | Escribe | Contenido |
|---|---|---|
| `status.json` | Colab | `state` (running/completed/failed/cancelled), `attempt`, `heartbeat`, `progress`, `avgStepSec`, `error`. Escritura atómica. |
| `checkpoint.json` (+`.prev`) | Colab | `step`, `at`, `state` restaurable. |
| `events.jsonl` | Colab | Registro del notebook (secretos redactados). |
| `result/` | Colab | Resultados. |
| `cancel.flag` | Termux | Petición de cancelación; el notebook la lee en `progress()`. |
| `notebooks/<id>.ipynb` | Termux | Notebook a abrir. |

Todo lo que llega de Colab se valida (esquema, `taskId`, intento, fechas) antes de tocar el registro; el estado de un intento anterior se ignora.

## Máquina de estados

```
pending ─► prepared ─► running ─► completed (final)
   │          │           ├─────► failed ─► prepared (retry/resume)
   └► cancelled ◄─────────┴─────► cancelled ─► prepared
```

`running` + fase `awaiting_start` = ejecución solicitada, aún sin primer latido. `failed` también se usa para «interrumpida» (`error.code = interrupted`).

## Disposición de datos (`~/.colab-manager/`, fuera del código)

`config.json` · `jobs/<id>.json` (+`.bak`) · `jobs/<id>.events.jsonl` · `notebooks/` · `sync/` · `logs/` · `trash/` · `backups/`. Un registro dañado e irrecuperable se aparta como `jobs/<id>.json.corrupt-FECHA` (nunca se borra).
Se usa un directorio de datos separado del código para que actualizar el código jamás toque los datos.

## Integración con Dekiller AI

`Manager` es independiente de la CLI: la API HTTP, la CLI y cualquier backend Express usan los mismos métodos.
Preparado: autenticación Bearer, consulta de estado, resultados, límites, registro de errores y proveedores intercambiables.
Pendiente (fase 5): cola con prioridades, usuarios/cuotas, y un proveedor con API real si existe uno aplicable.
