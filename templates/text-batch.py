def run(ctx):
    """Procesa una lista de textos. La reanudación es exacta: no duplica ni pierde líneas."""
    cfg = ctx.config
    items = cfg['items']
    op = cfg['operation']
    funcs = {
        'uppercase': lambda s: s.upper(),
        'wordcount': lambda s: len(s.split()),
        'sha256': lambda s: hashlib.sha256(s.encode('utf-8')).hexdigest(),
    }
    fn = funcs[op]
    out_path = os.path.join(ctx.result_dir, 'output.jsonl')
    done = int(ctx.state.get('done', 0))

    # Alinear el archivo de salida con el punto de recuperación (descarta líneas posteriores).
    lines = []
    if os.path.exists(out_path):
        with open(out_path, 'r', encoding='utf-8') as f:
            lines = f.read().splitlines()[:done]
    _atomic_write(out_path, ''.join(l + '\n' for l in lines))

    total = len(items)
    ctx.log(f'Operación {op}: {done}/{total} ya procesados.')
    with open(out_path, 'a', encoding='utf-8') as out:
        while done < total:
            t0 = time.time()
            out.write(json.dumps({'i': done, 'result': fn(items[done])}, ensure_ascii=False) + '\n')
            done += 1
            if done % ctx.checkpoint_every == 0 or done == total:
                out.flush()
                os.fsync(out.fileno())
                ctx.checkpoint(done, {'done': done})
            ctx.progress(done, total, step_seconds=time.time() - t0)
    ctx.save_result('summary.json', {'operation': op, 'processed': total})
