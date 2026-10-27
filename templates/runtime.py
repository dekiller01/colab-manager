# ===== Colab Manager · runtime v1 (generada automáticamente; no edite esta celda) =====
# Se ejecuta DENTRO de Google Colab. Solo usa la biblioteca estándar de Python.
# Responsabilidades: validar configuración, comprobar dependencias, guardar estado
# y latidos, crear puntos de recuperación, detectar ejecuciones previas incompletas,
# aceptar cancelación cooperativa y guardar resultados en almacenamiento persistente.
# NO mantiene la sesión artificialmente activa: solo escribe estado mientras trabaja.
import datetime
import hashlib
import importlib.metadata
import json
import os
import re
import subprocess
import sys
import time
import traceback

_SCHEMA = 1
_ID_RE = re.compile(r'^t-[0-9a-f]{8}$')
_PKG_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,60}(==[A-Za-z0-9.+!-]{1,30})?$')
_NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$')
_FOLDER_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$')
_SECRETS = [
    (re.compile(r'AIza[0-9A-Za-z_-]{20,}'), 'AIza***'),
    (re.compile(r'github_pat_[A-Za-z0-9_]{20,}'), 'github_pat_***'),
    (re.compile(r'gh[pousr]_[A-Za-z0-9]{20,}'), 'gh*_***'),
    (re.compile(r'ya29\.[0-9A-Za-z_-]{20,}'), 'ya29.***'),
    (re.compile(r'sk-[A-Za-z0-9_-]{20,}'), 'sk-***'),
    (re.compile(r'(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*', re.I), r'\1***'),
    (re.compile(r'((?:password|passwd|secret|token|api[_-]?key|authorization|cookie)["\']?\s*[:=]\s*["\']?)[^\s"\',;}]{4,}', re.I), r'\1***'),
]


def _redact(text):
    s = str(text)
    for rx, rep in _SECRETS:
        s = rx.sub(rep, s)
    return s


def _utcnow():
    return datetime.datetime.now(datetime.timezone.utc)


def _iso(dt=None):
    return (dt or _utcnow()).isoformat(timespec='seconds').replace('+00:00', 'Z')


def _parse_iso(s):
    try:
        return datetime.datetime.fromisoformat(s.replace('Z', '+00:00'))
    except Exception:
        return None


def _atomic_write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.{os.getpid()}.tmp'
    mode = 'wb' if isinstance(data, (bytes, bytearray)) else 'w'
    with open(tmp, mode, **({} if mode == 'wb' else {'encoding': 'utf-8'})) as f:
        f.write(data)
        f.flush()
        try:
            os.fsync(f.fileno())
        except OSError:
            pass
    os.replace(tmp, path)


def _read_json(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


class JobError(Exception):
    """Error esperado y explicable. El mensaje se muestra tal cual al usuario."""


class CancelRequested(Exception):
    """El administrador pidió cancelar (archivo cancel.flag en el directorio de la tarea)."""


def _validate_config(cfg):
    p = []
    if not isinstance(cfg, dict):
        raise JobError('CONFIG no es un objeto. Vuelva a generar el notebook con "colabctl notebook ID".')
    if cfg.get('schema') != _SCHEMA:
        p.append(f'schema={cfg.get("schema")!r} no es compatible con este runtime (se esperaba {_SCHEMA})')
    if not _ID_RE.match(str(cfg.get('taskId', ''))):
        p.append('taskId inválido')
    if not isinstance(cfg.get('attempt'), int) or cfg['attempt'] < 1:
        p.append('attempt debe ser un entero >= 1')
    if cfg.get('resumeMode') not in ('auto', 'fresh', 'resume'):
        p.append('resumeMode debe ser auto, fresh o resume')
    st = cfg.get('storage') or {}
    if st.get('mode') not in ('drive', 'local'):
        p.append('storage.mode debe ser "drive" o "local"')
    if not _FOLDER_RE.match(str(st.get('driveFolder', ''))):
        p.append('storage.driveFolder inválido')
    if not isinstance(cfg.get('job'), dict):
        p.append('job debe ser un objeto')
    reqs = cfg.get('requirements', [])
    if not isinstance(reqs, list) or any(not isinstance(r, str) or not _PKG_RE.match(r) for r in reqs):
        p.append('requirements contiene nombres de paquete inválidos')
    if p:
        raise JobError('La configuración del notebook no es válida:\n  - ' + '\n  - '.join(p))


def _resolve_base(storage):
    env = os.environ.get('COLABMGR_BASE')  # solo para pruebas locales
    if env:
        return env
    if storage['mode'] == 'drive':
        try:
            from google.colab import drive  # type: ignore
        except ImportError:
            raise JobError('storage.mode="drive" solo funciona dentro de Google Colab '
                           '(no se encontró google.colab). Use mode "local" para pruebas.')
        if not os.path.ismount('/content/drive'):
            print('Se pedirá autorización para montar su Google Drive (necesaria para guardar resultados).')
            drive.mount('/content/drive')
        return os.path.join('/content/drive/MyDrive', storage['driveFolder'])
    print('AVISO: almacenamiento "local": los archivos se PIERDEN al terminar la sesión de Colab.')
    return '/content/colab-manager'


def _check_requirements(reqs, allow_install):
    missing = []
    for r in reqs:
        name, _, ver = r.partition('==')
        try:
            have = importlib.metadata.version(name)
            if ver and have != ver:
                missing.append(r)
        except importlib.metadata.PackageNotFoundError:
            missing.append(r)
    if not missing:
        print('Dependencias: OK' if reqs else 'Dependencias: ninguna adicional.')
        return
    if not allow_install:
        raise JobError('Faltan dependencias: ' + ', '.join(missing) + '.\n'
                       'Por seguridad no se instalan automáticamente. Para permitirlo, cree la tarea con '
                       '{"allowInstall": true} en su configuración (colabctl add ... --config).')
    for r in missing:
        print(f'Instalando {r} ...')
        res = subprocess.run([sys.executable, '-m', 'pip', 'install', '--quiet', r],
                             capture_output=True, text=True, timeout=1800)
        if res.returncode != 0:
            raise JobError(f'No se pudo instalar {r}: {_redact(res.stderr.strip()[-400:])}')


class Ctx:
    """Objeto que recibe run(ctx). Es la única API que necesita un trabajo."""

    def __init__(self, cfg, task_dir, run_id):
        self.task_id = cfg['taskId']
        self.attempt = cfg['attempt']
        self.config = cfg['job']
        self.checkpoint_every = int(self.config.get('checkpointEvery', 5) or 5)
        self.dir = task_dir
        self.result_dir = os.path.join(task_dir, 'result')
        self.run_id = run_id
        self.state = {}          # se guarda en cada punto de recuperación
        self.resumed_from = None
        self._status_path = os.path.join(task_dir, 'status.json')
        self._events_path = os.path.join(task_dir, 'events.jsonl')
        self._ckpt_path = os.path.join(task_dir, 'checkpoint.json')
        self._cancel_path = os.path.join(task_dir, 'cancel.flag')
        self._st = {'schema': _SCHEMA, 'taskId': self.task_id, 'runId': run_id, 'attempt': self.attempt,
                    'state': 'running', 'startedAt': _iso(), 'heartbeat': _iso(), 'progress': None,
                    'avgStepSec': None, 'lastCheckpoint': None, 'error': None,
                    'python': sys.version.split()[0]}
        self._last_write = 0.0
        os.makedirs(self.result_dir, exist_ok=True)

    # --- estado y registro -------------------------------------------------
    def _write_status(self, force=False):
        now = time.time()
        if not force and now - self._last_write < 2.0:
            return
        self._st['heartbeat'] = _iso()
        _atomic_write(self._status_path, json.dumps(self._st, indent=2, ensure_ascii=False))
        self._last_write = now

    def log(self, msg, level='info'):
        line = {'ts': _iso(), 'src': 'colab', 'level': level, 'type': 'log',
                'attempt': self.attempt, 'msg': _redact(msg)}
        os.makedirs(self.dir, exist_ok=True)
        with open(self._events_path, 'a', encoding='utf-8') as f:
            f.write(json.dumps(line, ensure_ascii=False) + '\n')
        print(f'[{level}] {line["msg"]}')

    def should_cancel(self):
        return os.path.exists(self._cancel_path)

    def check_cancel(self):
        if self.should_cancel():
            raise CancelRequested()

    def progress(self, done, total=None, note=None, step_seconds=None):
        """Informa avance. Úselo en cada paso: actualiza el latido y comprueba cancelación."""
        self._st['progress'] = {'done': done, 'total': total, 'note': note}
        if step_seconds is not None and step_seconds >= 0:
            prev = self._st.get('avgStepSec')
            self._st['avgStepSec'] = round(step_seconds if prev is None else 0.7 * prev + 0.3 * step_seconds, 3)
        self._write_status(force=(total is not None and done >= total))
        self.check_cancel()

    def checkpoint(self, step, state=None):
        """Punto de recuperación atómico. 'state' (JSON) se restaura en self.state al reanudar."""
        if state is not None:
            self.state = state
        if os.path.exists(self._ckpt_path):
            try:
                os.replace(self._ckpt_path, self._ckpt_path + '.prev')
            except OSError:
                pass
        data = {'schema': _SCHEMA, 'taskId': self.task_id, 'runId': self.run_id, 'attempt': self.attempt,
                'step': step, 'at': _iso(), 'state': self.state}
        _atomic_write(self._ckpt_path, json.dumps(data, ensure_ascii=False))
        self._st['lastCheckpoint'] = {'step': step, 'at': data['at']}
        self._write_status(force=True)
        self.log(f'Punto de recuperación guardado (paso {step}).')

    def save_result(self, name, data):
        if not _NAME_RE.match(name) or '..' in name:
            raise JobError(f'Nombre de resultado inválido: {name!r}')
        if isinstance(data, (dict, list)):
            data = json.dumps(data, indent=2, ensure_ascii=False)
        _atomic_write(os.path.join(self.result_dir, name), data)
        self.log(f'Resultado guardado: {name}')

    def finish(self, state, error=None):
        self._st['state'] = state
        self._st['finishedAt'] = _iso()
        self._st['error'] = error
        self._write_status(force=True)


def _load_checkpoint(path):
    d = _read_json(path) or _read_json(path + '.prev')
    if isinstance(d, dict) and d.get('schema') == _SCHEMA and 'step' in d:
        return d
    return None


def main(CONFIG, run_fn):
    """Punto de entrada. Devuelve: completed | failed | cancelled | refused (no se tocó el estado)."""
    ctx = None
    owned = False  # solo tras pasar las comprobaciones de duplicado se puede escribir el estado
    try:
        print('Colab Manager runtime v1')
        _validate_config(CONFIG)
        base = _resolve_base(CONFIG['storage'])
        task_dir = os.path.join(base, CONFIG['taskId'])
        os.makedirs(task_dir, exist_ok=True)
        run_id = hashlib.sha256(f'{CONFIG["taskId"]}{time.time()}{os.getpid()}'.encode()).hexdigest()[:10]
        ctx = Ctx(CONFIG, task_dir, run_id)
        print(f'Tarea {ctx.task_id} · intento {ctx.attempt} · ejecución {run_id}')
        print(f'Almacenamiento: {task_dir}')

        prev = _read_json(os.path.join(task_dir, 'status.json'))
        incomplete = False
        if isinstance(prev, dict):
            if prev.get('state') == 'completed' and prev.get('attempt') == ctx.attempt and CONFIG['resumeMode'] != 'fresh':
                raise JobError(f'Este intento ({ctx.attempt}) ya terminó correctamente. No se repite para evitar duplicados.\n'
                               'Si necesita ejecutarlo otra vez, use "colabctl retry ID" en Termux y regenere el notebook.')
            if prev.get('state') == 'running':
                hb = _parse_iso(prev.get('heartbeat', ''))
                guard = CONFIG.get('concurrentGuardSec', 90)
                age = (_utcnow() - hb).total_seconds() if hb else 1e9
                if age < guard and prev.get('runId') != run_id:
                    raise JobError(f'Otra sesión parece estar ejecutando esta tarea (último latido hace {int(age)} s). '
                                   f'Si esa sesión ya no existe, espere {int(guard - age) + 1} s y vuelva a ejecutar.')
                incomplete = True
                ctx.log(f'Ejecución anterior incompleta detectada (run {prev.get("runId")}, último latido {prev.get("heartbeat")}).', 'warn')

        owned = True
        mode = CONFIG['resumeMode']
        if mode == 'fresh':
            stamp = _iso().replace(':', '-')
            for nm in ('checkpoint.json', 'checkpoint.json.prev', 'result'):
                p = os.path.join(task_dir, nm)
                if os.path.exists(p):
                    os.replace(p, f'{p}.{stamp}.old')
            os.makedirs(ctx.result_dir, exist_ok=True)
            ctx.log('Modo "fresh": se archivó el estado anterior (*.old) y se empieza desde cero.')
        else:
            ck = _load_checkpoint(ctx._ckpt_path)
            if ck:
                ctx.state = ck.get('state') or {}
                ctx.resumed_from = ck['step']
                ctx._st['lastCheckpoint'] = {'step': ck['step'], 'at': ck.get('at')}
                ctx.log(f'Reanudando desde el punto de recuperación del paso {ck["step"]}.')
            elif mode == 'resume':
                ctx.log('Se pidió reanudar pero no hay punto de recuperación: se empieza desde cero.', 'warn')
            elif incomplete:
                ctx.log('Había una ejecución incompleta sin punto de recuperación: se empieza desde cero.', 'warn')
        ctx._st['resumedFrom'] = ctx.resumed_from
        ctx._st['previousRunIncomplete'] = incomplete

        _check_requirements(CONFIG.get('requirements', []), bool(CONFIG.get('allowInstall')))
        ctx._write_status(force=True)
        ctx.log('Iniciando trabajo.')
        run_fn(ctx)
        ctx.finish('completed')
        ctx.log('Trabajo completado.')
        print('✅ Completado. Ejecute "colabctl sync" en Termux para traer los resultados.')
        return 'completed'
    except CancelRequested:
        if ctx and owned:
            ctx.finish('cancelled')
            ctx.log('Cancelado por solicitud del administrador.', 'warn')
        print('⏹ Cancelado por el administrador.')
        return 'cancelled'
    except JobError as e:
        msg = _redact(str(e))
        print(f'❌ {msg}')
        if ctx and owned:
            ctx.finish('failed', {'code': 'job_error', 'message': msg})
            ctx.log(msg, 'error')
        return 'refused' if (ctx and not owned) else 'failed'
    except KeyboardInterrupt:
        if ctx and owned:
            ctx.finish('failed', {'code': 'interrupted', 'message': 'Interrumpido manualmente en Colab.'})
        print('⏹ Interrumpido manualmente. El último punto de recuperación sigue disponible.')
        return 'failed'
    except Exception as e:  # error inesperado del trabajo
        msg = _redact(f'{type(e).__name__}: {e}')
        print(f'❌ Error inesperado: {msg}')
        if ctx and owned:
            ctx.finish('failed', {'code': 'exception', 'message': msg})
            ctx.log(msg, 'error')
            ctx.log(_redact(traceback.format_exc()[-3000:]), 'debug')
        return 'failed'
