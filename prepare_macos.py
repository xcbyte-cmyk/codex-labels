"""Prepare a separate, locally signed macOS Labels app; never edit the source app."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import subprocess
import sys
import uuid
from prepare_runtime import build_asar

ROOT = Path(__file__).resolve().parent
SUPPORTED_VERSION = '26.915.31945'

def prepare(source, destination, config):
    source, destination, config = [Path(p).expanduser().resolve() for p in (source, destination, config)]
    if sys.platform != 'darwin':
        raise RuntimeError('This builder requires macOS.')
    if destination.exists() or source == destination or source in destination.parents or destination in source.parents:
        raise ValueError('Choose a new destination outside the installed app.')
    info = plistlib.loads((source / 'Contents/Info.plist').read_bytes())
    if info.get('CFBundleIdentifier') != 'com.openai.codex' or info.get('CFBundleShortVersionString') != SUPPORTED_VERSION:
        raise RuntimeError('Unsupported source app. Inspect a new version before adding support.')
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(source)], check=True)
    destination.parent.mkdir(parents=True, exist_ok=True)
    config.mkdir(parents=True, exist_ok=True)
    try:
        with (config/'labels.json').open('xb') as f:
            f.write((ROOT/'labels.example.json').read_bytes())
    except FileExistsError:
        pass
    stage = destination.with_name('.labels-stage-' + uuid.uuid4().hex + '.app')
    subprocess.run(['ditto', str(source), str(stage)], check=True)
    # Failed staging directories are retained for diagnosis; the installed app stays intact.
    asar = stage / 'Contents/Resources/app.asar'
    patched = asar.with_name('labels-patched.asar')
    extra = {'.vite/build/codex-labels/updates-macos.cjs': (ROOT/'extension/updates-macos.cjs').read_bytes()}
    build_asar(asar, patched, config, extra, supported_version=SUPPORTED_VERSION, activity=False)
    patched.replace(asar)
    with asar.open('rb') as f:
        import struct
        _, _, _, length = struct.unpack('<IIII', f.read(16))
        header_hash = hashlib.sha256(f.read(length)).hexdigest()
    info['CFBundleDisplayName'] = 'Codex Labels'
    info['CFBundleName'] = 'Codex Labels'
    info['CFBundleIdentifier'] = 'local.codex-labels.mac'
    # Do not take over the original app's links or automatic update channel.
    info.pop('CFBundleURLTypes', None)
    info.pop('SUFeedURL', None)
    info['ElectronAsarIntegrity'] = {'Resources/app.asar': {'algorithm': 'SHA256', 'hash': header_hash}}
    (stage/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
    entitlements = stage.parent / (stage.stem + '-entitlements.plist')
    entitlements.write_bytes(plistlib.dumps({
        'com.apple.security.cs.allow-jit': True,
        'com.apple.security.cs.allow-unsigned-executable-memory': True,
        'com.apple.security.cs.disable-library-validation': True,
    }))
    try:
        subprocess.run(['codesign', '--force', '--deep', '--sign', '-', '--entitlements', str(entitlements), str(stage)], check=True)
    finally:
        entitlements.unlink()
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(stage)], check=True)
    stage.rename(destination)
    print(json.dumps({'app': str(destination), 'config': str(config)}, ensure_ascii=False))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', default='/Applications/ChatGPT.app')
    parser.add_argument('--destination', default=str(ROOT/'runtime/Codex Labels.app'))
    parser.add_argument('--config', default=str(Path.home()/'Library/Application Support/CodexLabels/Config'))
    args = parser.parse_args()
    prepare(args.source, args.destination, args.config)
