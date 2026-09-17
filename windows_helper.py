"""Per-PC preparation and launch helper; distributable without Python installed."""
import argparse
from contextlib import contextmanager
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

import prepare_runtime as builder

VERSION = '0.1.0'
ASSETS = Path(__file__).resolve().parent
HELPER_NAME = 'CodexLabelsHelper.exe'


def default_root():
    return Path(sys.executable).resolve().parent if getattr(sys, 'frozen', False) else ASSETS


def powershell(script, extra_env=None):
    if sys.platform != 'win32':
        raise RuntimeError('이 도구는 Windows x64용입니다.')
    env = os.environ.copy()
    env.update(extra_env or {})
    # Paths are data in the environment, never interpolated into script code.
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); " + script],
        env=env, capture_output=True, encoding='utf-8', errors='replace',
        creationflags=subprocess.CREATE_NO_WINDOW, timeout=60)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or 'Windows 환경을 확인하지 못했습니다.')
    return result.stdout.strip()


def installed_sources():
    text = powershell("@(Get-AppxPackage -Name OpenAI.Codex | ForEach-Object { $_.InstallLocation }) | ConvertTo-Json -Compress")
    values = json.loads(text) if text else []
    return [Path(value)/'app' for value in ([values] if isinstance(values, str) else values)]


def find_source(explicit=None):
    if explicit is not None:
        source = Path(explicit).resolve()
        builder.validate_source(source)
        return source
    candidates = installed_sources()
    if not candidates and builder.SOURCE.is_dir():
        candidates = [builder.SOURCE]
    for candidate in candidates:
        try:
            builder.validate_source(candidate)
            return candidate.resolve()
        except (ValueError, KeyError, OSError, RuntimeError):
            continue
    raise RuntimeError('지원하는 공식 Codex 설치본을 찾지 못했습니다. '
        '이 패키지는 Store 26.911.7940.0 / 내부 앱 ' + builder.SUPPORTED_APP_VERSION +
        '용입니다. 다른 버전은 호환 패키지가 필요합니다. 원본 앱은 변경하지 않았습니다.')


def profile_path():
    local = os.environ.get('LOCALAPPDATA')
    if not local:
        raise RuntimeError('LOCALAPPDATA 경로를 확인할 수 없습니다.')
    return Path(local)/'CodexLabels'/'User Data'


def running_apps():
    text = powershell("@(Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe'\" | "
        "Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:LABELS_PROFILE_CHECK) } | "
        "Select-Object -ExpandProperty ExecutablePath -Unique) | ConvertTo-Json -Compress",
        {'LABELS_PROFILE_CHECK': str(profile_path())})
    values = json.loads(text) if text else []
    return [Path(value).resolve() for value in ([values] if isinstance(values, str) else values) if value]


@contextmanager
def preparation_lock(root):
    """A kernel mutex releases on crashes; it leaves no stale lock file."""
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    name = 'Local\\CodexLabelsPrepare-' + hashlib.sha256(str(root).casefold().encode()).hexdigest()
    handle = kernel.CreateMutexW(None, False, name)
    if not handle:
        raise OSError('설치 잠금을 만들지 못했습니다.')
    try:
        if ctypes.get_last_error() == 183:
            raise RuntimeError('이 폴더의 설치 또는 업데이트가 이미 진행 중입니다.')
        yield
    finally:
        kernel.CloseHandle(handle)


def payload_fingerprint():
    digest = hashlib.sha256()
    files = [ASSETS/'prepare_runtime.py', ASSETS/'windows_helper.py', ASSETS/'labels.example.json']
    files += sorted((ASSETS/'extension').glob('*.js'))
    files += sorted(path for path in (ASSETS/'extension').glob('*.cjs') if not path.name.endswith('.test.cjs'))
    for file in files:
        digest.update(file.name.encode()); digest.update(file.read_bytes())
    return digest.hexdigest()


def read_receipt(root):
    receipt = root/'runtime/app/codex-labels-build.json'
    if not receipt.is_file():
        return None
    try:
        value = json.loads(receipt.read_text(encoding='utf-8'))
        return value if isinstance(value, dict) else None
    except (ValueError, OSError):
        return None


def require_ready(root):
    root = Path(root).resolve()
    receipt = read_receipt(root)
    exe = root/'runtime/app/ChatGPT.exe'
    if not receipt or receipt.get('version') != 3 or not exe.is_file():
        raise RuntimeError('먼저 설치.cmd를 실행해 이 PC의 라벨 실행본을 준비하세요.')
    if Path(receipt.get('configPath', '')).resolve() != root/'labels.json':
        raise RuntimeError('폴더 위치가 바뀌었습니다. 현재 폴더에서 설치.cmd를 다시 실행하세요.')
    if receipt.get('helperPayloadSha256') != payload_fingerprint():
        raise RuntimeError('새 버전 파일이 있습니다. 설치.cmd로 업데이트한 뒤 실행하세요.')
    return exe


def write_json(path, value):
    temp = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex)
    try:
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def prepare(root, source):
    root, source = Path(root).resolve(), Path(source).resolve()
    builder.validate_source(source)  # Validate before creating or moving anything.
    target = root/'runtime/app'
    if source == root or source in root.parents or root in source.parents:
        raise RuntimeError('공식 설치 폴더 밖의 별도 폴더에 압축을 풀어 주세요.')
    if (root/'runtime').resolve() != root/'runtime' or target.resolve() != target:
        raise RuntimeError('runtime 폴더의 바로가기 또는 연결 경로에는 설치할 수 없습니다.')
    if target.exists() and not read_receipt(root):
        raise RuntimeError('빌드 기록이 없는 runtime/app 폴더가 있습니다. 다른 빈 폴더에서 설치하세요.')
    try:
        require_ready(root)
        if read_receipt(root).get('sourceAsarSha256') == builder.file_hash(source/'resources/app.asar'):
            return {'ready': True, 'root': str(root), 'backup': None, 'alreadyPrepared': True}
    except RuntimeError:
        pass
    if target.exists() and (target/'ChatGPT.exe').resolve() in running_apps():
        raise RuntimeError('이 폴더의 Codex Labels 창을 닫은 뒤 다시 설치하세요. 원본 Codex는 열어 두어도 됩니다.')
    root.mkdir(parents=True, exist_ok=True)
    needed = sum(file.stat().st_size for file in source.rglob('*') if file.is_file()) + 512 * 1024 * 1024
    if shutil.disk_usage(root).free < needed:
        raise RuntimeError(f'설치 공간이 부족합니다. 약 {needed / (1024**3):.1f}GB의 여유 공간이 필요합니다.')
    if root != ASSETS:
        shutil.copyfile(ASSETS/'labels.example.json', root/'labels.example.json')
    # Keep the old working runtime until the new staged build is verified. Never
    # delete backups automatically, and never move a path outside this root.
    backup = None
    if target.exists():
        backup = target.with_name('app.backup-' + datetime.now().strftime('%Y%m%d-%H%M%S-') + uuid.uuid4().hex[:8])
        target.rename(backup)
    try:
        builder.prepare_runtime(source, root)
        receipt = read_receipt(root)
        receipt.update(helperVersion=VERSION, helperPayloadSha256=payload_fingerprint())
        write_json(target/'codex-labels-build.json', receipt)
        write_json(root/'build-manifest.json', receipt)
    except Exception:
        if backup is not None:
            # Preserve even an incomplete new runtime for diagnosis before restore.
            if target.exists():
                target.rename(target.with_name('app.failed-' + uuid.uuid4().hex[:8]))
            backup.rename(target)
            write_json(root/'build-manifest.json', read_receipt(root))
        raise
    return {'ready': True, 'root': str(root), 'backup': str(backup) if backup else None}


def create_shortcut(root, destination=None):
    root = Path(root).resolve()
    helper = root/HELPER_NAME
    if not helper.is_file():
        raise RuntimeError('바로가기는 배포 ZIP의 실행 도구에서 만들 수 있습니다.')
    # Environment lookup also supports a OneDrive-redirected Desktop. Do not
    # replace a shortcut owned by another copy or application.
    script = """
    $destination = $env:LABELS_LINK_DEST
    if (-not $destination) { $destination = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex Labels.lnk' }
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($destination)
    if ((Test-Path -LiteralPath $destination) -and (($link.TargetPath -ne $env:LABELS_HELPER_PATH) -or ($link.Arguments -ne 'launch'))) {
        throw '다른 실행본의 Codex Labels 바로가기가 이미 있습니다. 설치는 완료됐으며 실행.cmd를 사용하세요.'
    }
    $link.TargetPath = $env:LABELS_HELPER_PATH
    $link.Arguments = 'launch'
    $link.WorkingDirectory = $env:LABELS_ROOT_PATH
    $link.WindowStyle = 7
    $link.Description = 'Codex Labels 실행'
    $link.IconLocation = $env:LABELS_ICON_PATH
    $link.Save()
    $destination
    """
    return powershell(script, {'LABELS_HELPER_PATH': str(helper), 'LABELS_ROOT_PATH': str(root),
        'LABELS_ICON_PATH': str(root/'runtime/app/ChatGPT.exe'), 'LABELS_LINK_DEST': str(destination or '')})


def launch(root):
    root = Path(root).resolve()
    exe = require_ready(root)
    if any(app != exe.resolve() for app in running_apps()):
        raise RuntimeError('다른 폴더의 Codex Labels가 실행 중입니다. 해당 Labels 창을 닫고 다시 실행하세요.')
    profile = profile_path()
    profile.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env['CODEX_ELECTRON_USER_DATA_PATH'] = str(profile)
    env.pop('ELECTRON_RUN_AS_NODE', None)
    process = subprocess.Popen([str(exe), '--user-data-dir=' + str(profile)], cwd=exe.parent,
        env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    status = {'version': 3, 'status': 'launch-requested', 'processId': process.pid,
        'executable': str(exe), 'profile': str(profile), 'originalAppStopped': False}
    write_json(root/'launch-status.json', status)
    return status


def main():
    if sys.stdout:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(description='Codex Labels Windows 설치·실행 도구')
    parser.add_argument('action', choices=['prepare', 'launch', 'check'], nargs='?', default='prepare')
    parser.add_argument('--root', type=Path, default=default_root())
    parser.add_argument('--source', type=Path)
    parser.add_argument('--shortcut', action='store_true')
    parser.add_argument('--version', action='version', version=VERSION)
    args = parser.parse_args()
    root = args.root.resolve()
    try:
        if sys.platform != 'win32':
            raise RuntimeError('Windows x64 PC에서 실행하세요.')
        if args.action == 'check':
            source = find_source(args.source)
            try:
                require_ready(root); ready = True
            except RuntimeError:
                ready = False
            result = {'helperVersion': VERSION, 'supportedAppVersion': builder.SUPPORTED_APP_VERSION,
                'source': str(source), 'root': str(root), 'ready': ready, 'originalInstallModified': False}
        elif args.action == 'prepare':
            with preparation_lock(root):
                print('공식 Codex를 확인하고 라벨 기능을 준비하고 있습니다. 잠시 기다려 주세요.', flush=True)
                result = prepare(root, find_source(args.source))
                if args.shortcut:
                    result['shortcut'] = create_shortcut(root)
            print('준비 완료. 다음부터 실행.cmd 또는 바탕화면 바로가기를 사용하세요.', flush=True)
        else:
            result = launch(root)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        message = 'Codex Labels: ' + str(error)
        print(message, flush=True)
        if args.action == 'launch' and getattr(sys, 'frozen', False):
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, message, 'Codex Labels', 0x10)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
