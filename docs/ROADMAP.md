# Plan de desarrollo por fases

| Fase | Alcance | Estado |
|---|---|---|
| **1** | CLI local, registro persistente atómico, gestor de tareas, estados, validación, seguridad básica | ✅ Hecha y probada localmente |
| **2** | Generador de notebooks, runtime (checkpoints, resultados, ejecución incompleta), tipos `demo-counter`, `text-batch`, `script` | ✅ Hecha · ⚠️ validar en Colab real |
| **3** | Sincronización por canal autorizado: `folder`, `rclone` (Drive), `github` | ✅ Hecha con herramientas simuladas · ⚠️ validar con Drive/GitHub reales |
| **4** | Monitor, reintentos controlados, recuperación, anti-duplicados, backup/restore | ✅ Hecha y probada localmente |
| **5a** | API HTTP para Dekiller AI (estado, tareas, logs, resultados, límites) | ✅ Base hecha |
| **5b** | Cola persistente con prioridades, usuarios y cuotas, webhooks de finalización | ⏳ Pendiente |
| **5c** | Proveedor de cómputo adicional con API oficial (p. ej. Colab Enterprise o servicio de pago/gratuito con API) | ⏳ Pendiente; requiere una cuenta/servicio que usted decida |

## Siguientes pasos recomendados (en orden)

1. Prueba real: tarea `demo-counter` pequeña con `channel: none` (subida manual) para validar el notebook y el montaje de Drive.
2. Configurar `rclone` y repetir con `colabctl sync` para validar el ciclo completo desde el teléfono.
3. Provocar un fallo (`failAtStep`) y comprobar `monitor` + `resume` con una desconexión real.
4. Solo entonces, tareas pesadas reales (un tipo `llm-inference` que exija `allowModelDownload` explícito).
5. Fase 5b según las necesidades de Dekiller AI.
