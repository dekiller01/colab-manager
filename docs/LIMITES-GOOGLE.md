# Límites reales de Google Colab y decisiones de diseño

Investigación realizada el 2026-10-10 sobre documentación oficial. Todo lo que no pude confirmar está marcado.

## Hallazgos

| Tema | Qué dice la documentación | Consecuencia para el diseño |
|---|---|---|
| API pública para sesiones de Colab gratuito | El [FAQ de Colab](https://research.google.com/colaboratory/faq.html) no menciona ninguna API oficial para iniciar/detener/consultar runtimes. Para recursos garantizados remite a Colab Enterprise o a un runtime local. **No encontré** ninguna API pública para cuentas gratuitas. | El proveedor por defecto es **asistido (`manual`)**. No se inventan endpoints. |
| Control programático de runtimes | Existe `gcloud colab runtimes start/stop` ([doc](https://docs.cloud.google.com/sdk/gcloud/reference/colab/runtimes/start)), pero es de **Colab Enterprise** (proyecto de Google Cloud con facturación). | Proveedor `colab-enterprise` declarado y **no implementado**; responde con el motivo. |
| Ejecución programada | La programación de notebooks está documentada en la sección de Google Cloud / Colab Enterprise ([doc](https://docs.cloud.google.com/colab/docs/schedule-notebook-run)). No la evalué en detalle ni la probé. | No hay «programación» en cuentas gratuitas: lo programado lo hace usted abriendo el notebook. |
| Duración | Notebooks gratuitos: «como máximo 12 horas, según disponibilidad y uso»; los runtimes se desconectan por inactividad y Google **no publica** los límites exactos. | Puntos de recuperación frecuentes y reanudación; el monitor no promete disponibilidad. |
| Ejecución en segundo plano | El FAQ la presenta como beneficio de planes de pago. | No se intenta mantener sesiones vivas. |
| Acciones prohibidas | Entre otras: minería, torrents, proxies remotos, múltiples cuentas para esquivar límites y, en runtimes gratuitos, control remoto (SSH, escritorio remoto) o trabajar principalmente por una interfaz web evitando la interfaz del notebook; pueden terminarse sin aviso. | Se descarta cualquier túnel/SSH/servidor expuesto desde Colab. La comunicación es por **archivos** en un canal autorizado. |
| Abrir notebooks | Colab abre notebooks desde Drive o desde GitHub (por URL), y por «Subir cuaderno». | Canales `github` (enlace directo) y `rclone`/`folder` (Drive) + subida manual. |

## Qué es automático y qué no

* **Automático desde Termux:** crear/validar tareas, generar notebooks, subir notebooks y banderas de cancelación al canal, traer estado/checkpoints/resultados, vigilar latidos, marcar interrumpidas, preparar reintentos/reanudaciones.
* **Siempre manual (limitado por Google):** abrir el notebook en Colab, pulsar *Ejecutar todo*, autorizar el montaje de Drive, detener realmente una sesión (la cancelación es *cooperativa*: el notebook la lee en cada `progress()`).
* **No se hace nunca:** extraer cookies o tokens, automatizar el inicio de sesión de Google, evadir CAPTCHA o límites, simular actividad para evitar la desconexión.

## Lista de funciones

| Función | Estado |
|---|---|
| CLI `status add list run logs cancel retry resume notebook sync` | ✅ Implementada (local; flujo asistido) |
| Registro persistente atómico, `.bak`, recuperación, cuarentena | ✅ Probada localmente |
| Estados y transiciones validadas; reintentos limitados | ✅ Probada localmente |
| Generador de notebooks (3 tipos), runtime con checkpoints y detección de ejecución incompleta | ✅ Probada en simulación local · ⚠️ falta prueba real en Colab |
| Canales `folder`, `rclone`, `github` | ✅ Probados con herramientas simuladas · ⚠️ falta prueba real (Drive/GitHub) |
| Monitor (activa / lenta / desconexión probable / sin datos) | ✅ Probado localmente |
| Backup / restore | ✅ Probado localmente |
| API HTTP autenticada para Dekiller AI (estado, tareas, logs, resultados) | ✅ Probada localmente |
| Cola de trabajos persistente con prioridades; autenticación por usuario; cuotas por usuario | ⏳ Pendiente (fase 5) |
| Proveedor `colab-enterprise` (requiere Google Cloud con facturación) | ⏳ Pendiente y fuera del alcance gratuito |
| Proveedor `colab-api` para cuentas gratuitas | 🚫 No existe API oficial conocida |
| Iniciar/detener/consultar sesiones de Colab gratuito directamente | 🚫 Limitado por Google |
| Mantener sesiones activas / garantizar disponibilidad | 🚫 No se hace ni se hará |
