"""Delete only an explicitly selected local account profile, without backups."""
import os
from pathlib import Path
import shutil
import stat
import time
import psutil
import account_profiles as profiles


def _same_path(a, b):
    return bool(a) and os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def _owns_process(process, root, account_id, directory):
    """Never trust a stale runtime-status PID or a substring of a command line."""
    try:
        args = process.cmdline()
        if _same_path(process.exe(), Path(root)/'runtime/app/ChatGPT.exe'):
            if '--codex-labels-account=' + account_id in args: return True
            if any(arg.startswith('--user-data-dir=') and
                   _same_path(arg.split('=', 1)[1], directory/'user-data') for arg in args): return True
        env = process.environ()
        return (env.get('CODEX_LABELS_ACCOUNT_ID') in (None, account_id) and
                _same_path(env.get('CODEX_HOME'), directory/'codex-home'))
    except psutil.NoSuchProcess:
        return False


def account_processes(root, account_id, *, runtime_root=None):
    root = Path(root).resolve(); directory = profiles.account_path(root, account_id)
    candidates = {}
    # Scan the shared runtime first. Unrelated applications' environments are
    # never inspected. Include its descendants to find tools outside runtime/.
    runtime_root = Path(runtime_root or root).resolve()
    runtime = runtime_root/'runtime/app'
    for process in psutil.process_iter(['exe']):
        try:
            if process.info['exe'] and Path(process.info['exe']).resolve().is_relative_to(runtime):
                candidates[process.pid] = process
                for child in process.children(recursive=True): candidates[child.pid] = child
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    result = []
    for process in candidates.values():
        try:
            if _owns_process(process, runtime_root, account_id, directory): result.append(process)
        except psutil.AccessDenied as error:
            raise RuntimeError('계정 창의 실행 상태를 확인할 수 없어 삭제를 중단했습니다.') from error
    return result


def stop_account(root, account_id, *, runtime_root=None):
    stopped = set()
    deadline = time.monotonic() + 15
    while True:
        processes = account_processes(root, account_id, runtime_root=runtime_root)
        if not processes: return len(stopped)
        if time.monotonic() >= deadline:
            raise RuntimeError('계정 창의 프로세스가 종료되지 않았습니다. 창을 종료한 뒤 삭제를 다시 시도하세요.')
        suspended = []
        try:
            # Stop new child launches while collecting the owned process tree.
            for process in processes:
                try: process.suspend(); suspended.append(process)
                except (psutil.NoSuchProcess, psutil.AccessDenied): pass
            owned = {p.pid: p for p in processes}
            for process in processes:
                try:
                    for child in process.children(recursive=True):
                        if _owns_process(child, runtime_root or root, account_id, profiles.account_path(root, account_id)):
                            owned[child.pid] = child
                except psutil.NoSuchProcess: pass
            for process in reversed(list(owned.values())):
                try: process.terminate(); stopped.add(process.pid)
                except psutil.NoSuchProcess: pass
            _, alive = psutil.wait_procs(list(owned.values()), timeout=5)
            if alive: raise RuntimeError('종료되지 않은 계정 프로세스가 있습니다. 삭제를 다시 시도하세요.')
        except psutil.AccessDenied as error:
            raise RuntimeError('계정 프로세스를 종료할 수 없어 삭제를 중단했습니다.') from error
        finally:
            for process in suspended:
                try: process.resume()
                except psutil.NoSuchProcess: pass
        # Rescan for startup races/orphans; never silently ignore surviving IO.


def _remove_readonly(function, filename, error_info):
    error = error_info[1]
    if not isinstance(error, PermissionError): raise error
    # rmtree does not follow directory junctions on supported Python versions.
    # Only clear a read-only flag on the path it is already trying to remove.
    if os.path.islink(filename) or getattr(os.lstat(filename), 'st_file_attributes', 0) & 0x400: raise error
    os.chmod(filename, stat.S_IWRITE | stat.S_IREAD)
    function(filename)


def delete_account(root, account_id, *, progress=None, stop=None):
    """Caller holds the same installation mutex as account launch/prepare."""
    root = Path(root).resolve()
    directory = profiles.account_path(root, account_id)
    # Validate the final absolute destination before recursive deletion.
    if directory.parent != root/'accounts' or directory.resolve() != directory:
        raise ValueError('계정 저장소 밖의 경로는 삭제할 수 없습니다.')
    marker = profiles.deletion_marker(root, account_id)
    progress = progress or (lambda *_: None)
    pending = profiles.pending_deletion(root, account_id)
    if not pending:
        if not directory.exists():
            count = (stop or stop_account)(root, account_id)
            return {'deleted': True, 'alreadyDeleted': True, 'remainingFiles': 0, 'stoppedProcesses': count}
        profiles.read(root, account_id)
        metadata = directory/'account.json'
        if metadata.is_symlink(): raise ValueError('연결된 계정 설정은 삭제할 수 없습니다.')
        # Atomic removal of bootstrap metadata blocks direct executable launches
        # too, including older account-aware runtimes. The marker supports retry.
        os.replace(metadata, marker)
    progress('선택한 계정 창과 실행 중인 작업을 종료하고 있습니다', 20)
    try:
        count = (stop or stop_account)(root, account_id)
        progress('로그인·대화·설정·캐시를 삭제하고 있습니다', 55)
        if directory.exists():
            # Native Windows long paths are needed for nested plugin caches.
            target = str(directory)
            if os.name == 'nt' and not target.startswith('\\\\?\\'):
                target = '\\\\?\\UNC\\' + target[2:] if target.startswith('\\\\') else '\\\\?\\' + target
            shutil.rmtree(target, onerror=_remove_readonly)
        if directory.exists() or directory.is_symlink():
            raise RuntimeError('계정 폴더에 남은 자료가 있습니다.')
        # The marker is the final record removed, never before verified cleanup.
        marker.unlink()
    except (OSError, RuntimeError) as error:
        raise RuntimeError('삭제를 완료하지 못했습니다. 목록의 ‘삭제 미완료’ 항목에서 다시 삭제하세요. '
                           + str(error)) from error
    progress('계정 창과 로컬 자료를 삭제했습니다', 100)
    return {'deleted': True, 'accountProfileId': account_id, 'stoppedProcesses': count,
            'remainingFiles': 0, 'backupCreated': False}
