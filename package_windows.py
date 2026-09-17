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
PAYLOAD = ['labels.example.json', 'prepare_runtime.py', 'windows_helper.py', 'updater.py', 'launcher_ui.py'] + [
    'extension/' + name for name in ['main.cjs', 'preload.js', 'store.cjs', 'renderer.js', *builder.EXTRA_EXTENSION_FILES]]


def write_zip(executable, destination, source_commit, license_files):
    """Explicit allowlist: no runtime/, assignments, profiles, or developer logs."""
    files = [(executable, HELPER_NAME)]
    files += [(ROOT/'packaging'/name, name) for name in ['설치.cmd', '실행.cmd', '사용안내.txt']]
    files += license_files
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
        for source, name in files:
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
        python_license = Path(sys.base_prefix)/'LICENSE.txt'
        distribution_info = distribution('pyinstaller')
        license_entry = next(file for file in distribution_info.files if str(file).endswith('COPYING.txt'))
        pyinstaller_license = distribution_info.locate_file(license_entry)
        archive = output/f'Codex-Labels-v{VERSION}-windows-x64.zip'
        write_zip(work/'dist'/HELPER_NAME, archive, source_commit,
            [(python_license, 'PYTHON-LICENSE.txt'), (pyinstaller_license, 'PYINSTALLER-LICENSE.txt')])
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output/'SHA256SUMS.txt').write_text(checksum + '  ' + archive.name + '\n', encoding='ascii')
    print(json.dumps({'zip': str(archive), 'sha256': checksum, 'sourceCommit': source_commit}))


if __name__ == '__main__':
    main()
