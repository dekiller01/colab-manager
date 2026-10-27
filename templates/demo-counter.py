def run(ctx):
    """Demostración: cuenta pasos, con puntos de recuperación y cancelación cooperativa."""
    cfg = ctx.config
    steps = int(cfg.get('steps', 20))
    pause = float(cfg.get('sleepSec', 1))
    fail_at = cfg.get('failAtStep')          # solo para probar fallos: falla únicamente en el intento 1
    counter = int(ctx.state.get('counter', 0))
    ctx.log(f'Empezando en {counter}/{steps}')
    while counter < steps:
        t0 = time.time()
        time.sleep(pause)
        counter += 1
        if fail_at and ctx.attempt == 1 and counter == int(fail_at):
            raise JobError(f'Fallo simulado en el paso {counter} (failAtStep, solo intento 1).')
        ctx.state['counter'] = counter
        ctx.progress(counter, steps, step_seconds=time.time() - t0)
        if counter % ctx.checkpoint_every == 0 and counter < steps:
            ctx.checkpoint(counter)
    ctx.save_result('result.json', {'counter': counter, 'steps': steps, 'attempt': ctx.attempt,
                                    'resumedFrom': ctx.resumed_from})
