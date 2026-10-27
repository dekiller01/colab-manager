# Ejemplo de tarea propia para: colabctl add "mi tarea" --script examples/mi-tarea.py --config '{"n": 30}'
# Contrato: definir run(ctx). El runtime ya importó: json, os, re, sys, time, hashlib, JobError.
# - ctx.config            configuración de la tarea (dict)
# - ctx.state             dict que se restaura tras un punto de recuperación
# - ctx.attempt           número de intento
# - ctx.progress(done, total, note=None, step_seconds=None)   latido + comprobación de cancelación
# - ctx.checkpoint(step, state=None)                          punto de recuperación atómico
# - ctx.save_result(nombre, dato)                             guarda en el almacenamiento persistente
# - ctx.log(mensaje)      registro (se redacta automáticamente si parece un secreto)
def run(ctx):
    n = int(ctx.config.get('n', 20))
    if n < 1 or n > 100000:
        raise JobError('n debe estar entre 1 y 100000')
    done = ctx.state.get('done', [])          # reanuda con lo ya calculado
    for i in range(len(done) + 1, n + 1):
        t0 = time.time()
        done.append(i * i)
        ctx.state['done'] = done
        ctx.progress(i, n, step_seconds=time.time() - t0)
        if i % ctx.checkpoint_every == 0 and i < n:
            ctx.checkpoint(i)
    ctx.save_result('cuadrados.json', {'n': n, 'cuadrados': done, 'reanudado_desde': ctx.resumed_from})
