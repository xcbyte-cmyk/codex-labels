"""Create the source-only-customization ZIP; never bundle an installed Codex."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile

import prepare_runtime as builder
from windows_helper import HELPER_NAME, VERSION

ROOT = Path(__file__).resolve().parent
PAYLOAD = ['labels.example.json', 'prepare_runtime.py', 'windows_helper.py', 'updater.py', 'launcher_ui.py', 'runtime_recovery.py', 'account_profiles.py', 'account_manager.py', 'account_cleanup.py'] + [
    'extension/' + name for name in ['main.cjs', 'preload.js', 'store.cjs', 'renderer.js', *builder.EXTRA_EXTENSION_FILES]]


def write_zip(executable, destination, source_commit, license_files):
    """Explicit allowlist: no runtime/, assignments, profiles, or developer logs."""
    files = [(executable, HELPER_NAME)]
    files += [(ROOT/'packaging'/name, name) for name in ['설치.cmd', '실행.cmd', '계정별 실행.cmd', '사용안내.txt']]
    files += license_files
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
        for source, name in files:
            if name.endswith('.cmd'):
                archive.writestr(name, source.read_bytes().replace(b'\r\n', b'\n').replace(b'\n', b'\r\n'))
            else:
                archive.write(source, name)
        archive.writestr('build-info.json', json.dumps({'version': VERSION, 'sourceCommit': source_commit,
            'supportedAppVersion': builder.SUPPORTED_APP_VERSION, 'containsCodexBinaries': False}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT/'dist')
    args = parser.parse_args()
    if sys.platform != 'win32':
        raise SystemExit('Build on Windows x64 with packaging/requirements-build.txt installed.')
    output = args.output.resolve(); output.mkdir(parents=True, exist_ok=True)
    source_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    with tempfile.TemporaryDirectory(prefix='labels-package-', dir=output) as temporary:
        work = Path(temporary)
        assets = work/'assets'; assets.mkdir()
        for relative in PAYLOAD:
            target = assets/relative; target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT/relative, target)
        command = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile', '--noupx',
            '--name', Path(HELPER_NAME).stem, '--distpath', str(work/'dist'), '--workpath', str(work/'build'),
            '--specpath', str(work), '--add-data', str(assets) + ':.', str(ROOT/'windows_helper.py')]
        subprocess.run(command, cwd=ROOT, check=True)
        from importlib.metadata import distribution
        python_license = next((Path(sys.base_prefix)/name for name in ('LICENSE.txt', 'LICENSE_PYTHON.txt')
                               if (Path(sys.base_prefix)/name).is_file()), None)
        if python_license is None:
            raise RuntimeError('Python runtime license file was not found.')
        distribution_info = distribution('pyinstaller')
        license_entry = next(file for file in distribution_info.files if str(file).endswith('COPYING.txt'))
        pyinstaller_license = distribution_info.locate_file(license_entry)
        psutil_info = distribution('psutil')
        psutil_license = psutil_info.locate_file(next(file for file in psutil_info.files if str(file).endswith('/LICENSE')))
        archive = output/f'Codex-Labels-v{VERSION}-windows-x64.zip'
        write_zip(work/'dist'/HELPER_NAME, archive, source_commit,
            [(python_license, 'PYTHON-LICENSE.txt'), (pyinstaller_license, 'PYINSTALLER-LICENSE.txt'), (psutil_license, 'PSUTIL-LICENSE.txt')])
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output/'SHA256SUMS.txt').write_text(checksum + '  ' + archive.name + '\n', encoding='ascii')
    print(json.dumps({'zip': str(archive), 'sha256': checksum, 'sourceCommit': source_commit}))


if __name__ == '__main__':
    main()
