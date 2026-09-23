"""Build a separate Codex runtime. Never changes WindowsApps or its permissions."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import uuid

ROOT = Path(__file__).resolve().parent
VERSION = 'OpenAI.Codex_26.915.4065.0_x64__2p2nqsd0c76g0'
SOURCE = Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'WindowsApps' / VERSION / 'app'
MARKER = b'// codex-labels-v1'
SUPPORTED_APP_VERSION = '26.915.31945'
ACTIVITY_BUNDLE = 'webview/assets/app-initial-6c4523b43a11.js'
ACTIVITY_CONTROLLER = 'ep(o,n)'
ACTIVITY_COORDINATION = 'yU.clientCoordination'
EXTRA_EXTENSION_FILES = ('notification-core.cjs', 'notifications.cjs', 'snapshot-cache.cjs', 'notification-renderer.js', 'windows-shortcuts.cjs', 'activity-sync.cjs', 'updates.cjs', 'account-profile.cjs', 'vocabulary.cjs', 'vocabulary-ipc.cjs', 'vocabulary-renderer.js', 'auto-account-renderer.js', 'auto-account-main.cjs')
MAX_HEADER_BYTES = 64 * 1024 * 1024


def entries(header, prefix=''):
    for name, item in header.get('files', {}).items():
        if not name or name in ('.', '..') or '/' in name or '\\' in name:
            raise ValueError('Invalid archive member name')
        key = prefix + name
        if 'files' in item:
            yield from entries(item, key + '/')
        else:
            yield key, item


def read_index(file):
    file.seek(0)
    prefix = file.read(16)
    if len(prefix) != 16:
        raise ValueError('Truncated archive header')
    word, size, pickle_size, length = struct.unpack('<IIII', prefix)
    if word != 4 or size < 8 or size > MAX_HEADER_BYTES or size % 4 or pickle_size != size - 4 or length > size - 8:
        raise ValueError('Invalid archive header')
    raw = file.read(length)
    if len(raw) != length:
        raise ValueError('Truncated archive header')
    header = json.loads(raw)
    if not isinstance(header, dict) or not isinstance(header.get('files'), dict):
        raise ValueError('Invalid archive file index')
    return header, 8 + size


def digest(data, block=4194304):
    if not isinstance(block, int) or not 1 <= block <= MAX_HEADER_BYTES:
        raise ValueError('Invalid integrity block size')
    return {'algorithm': 'SHA256', 'hash': hashlib.sha256(data).hexdigest(), 'blockSize': block,
            'blocks': [hashlib.sha256(data[i:i+block]).hexdigest() for i in range(0, len(data), block)]}


def build_asar(source, target, config_directory, extra=None, *, refresh=False):
    source, target = Path(source), Path(target)
    if source.resolve() == target.resolve():
        raise ValueError('The source archive must never be the target')
    temp = target.with_name(target.name + '.tmp-' + uuid.uuid4().hex)
    try:
        with source.open('rb') as src:
            header, base = read_index(src)
            original = dict(entries(copy.deepcopy(header)))
            archive_size = source.stat().st_size
            # Historical experimental builds can still exist on a user's PC.
            # Keep this guard even though those modules are no longer shipped.
            if refresh and any(name.startswith('.vite/build/codex-labels/session-switcher/') or
                               name == '.vite/build/codex-labels/session-switcher-renderer.js'
                               for name in original):
                raise RuntimeError('Rebuild a separate candidate from the original Codex installation; do not refresh an experimental switcher runtime.')

            def read(name):
                item = original[name]
                if item.get('unpacked') or 'link' in item:
                    raise ValueError('Required bootstrap file must be packed: ' + name)
                offset, size = int(item['offset']), item['size']
                if not isinstance(size, int) or size < 0 or offset < 0 or base + offset + size > archive_size:
                    raise ValueError('Invalid archive member bounds: ' + name)
                src.seek(base + offset)
                data = src.read(size)
                if len(data) != size:
                    raise ValueError('Truncated archive member: ' + name)
                return data

            if json.loads(read('package.json'))['version'] != SUPPORTED_APP_VERSION:
                raise RuntimeError('Unsupported app version. Inspect the new version before patching.')
            early, preload = '.vite/build/early-bootstrap.js', '.vite/build/preload.js'
            early_source, preload_source = read(early), read(preload)
            prefix = MARKER + b'\nrequire("./codex-labels-main.cjs");\n'
            if refresh:
                if not early_source.startswith(prefix) or early_source.count(MARKER) != 1 or preload_source.count(MARKER) != 1:
                    raise RuntimeError('Unknown existing Labels patch; keep the current runtime.')
                early_source = early_source[len(prefix):]
                preload_source = preload_source.split(b'\n' + MARKER + b'\n')[0]
            elif MARKER in early_source or MARKER in preload_source:
                raise RuntimeError('The source is already patched; use the unmodified installed app.')
            changed = {
                early: prefix + early_source,
                preload: preload_source + b'\n' + MARKER + b'\n' + (ROOT/'extension/preload.js').read_bytes(),
                '.vite/build/codex-labels-main.cjs': (ROOT/'extension/main.cjs').read_bytes(),
                '.vite/build/codex-labels-store.cjs': (ROOT/'extension/store.cjs').read_bytes(),
                '.vite/build/codex-labels-renderer.js': (ROOT/'extension/renderer.js').read_bytes(),
                '.vite/build/codex-labels-location.json': json.dumps({'configDirectory': str(config_directory)}, ensure_ascii=False).encode('utf-8'),
            }
            for name in EXTRA_EXTENSION_FILES:
                changed['.vite/build/codex-labels/' + name] = (ROOT/'extension'/name).read_bytes()
            # Exact-version hooks into the existing catalog observation path.
            # Fail closed on upstream changes; never infer active state from labels.
            activity_bundle = ACTIVITY_BUNDLE
            if activity_bundle not in original:
                raise RuntimeError('Unsupported activity catalog bundle; original installation was not changed.')
            activity_source = read(activity_bundle).decode('utf-8')
            if refresh:
                old_activity = read('.vite/build/codex-labels/activity-sync.cjs').decode('utf-8') + '\n'
                if not activity_source.startswith(old_activity):
                    raise RuntimeError('Unknown activity patch; keep the current runtime.')
                activity_source = activity_source[len(old_activity):]
                for variable in ('e', 'r'):
                    inserted = f',globalThis.__codexLabelsActivitySync.observe(n,{variable},{ACTIVITY_CONTROLLER},{ACTIVITY_COORDINATION})'
                    if activity_source.count(inserted) != 1:
                        raise RuntimeError('Unknown activity hook; keep the current runtime.')
                    activity_source = activity_source.replace(inserted, '', 1)
            for variable in ('e', 'r'):
                anchor = f'{ACTIVITY_CONTROLLER}.observeCatalogThreads({variable})'
                if activity_source.count(anchor) != 1:
                    raise RuntimeError('Unsupported activity catalog hook; original installation was not changed.')
                activity_source = activity_source.replace(anchor, anchor +
                    f',globalThis.__codexLabelsActivitySync.observe(n,{variable},{ACTIVITY_CONTROLLER},{ACTIVITY_COORDINATION})')
            changed[activity_bundle] = (ROOT/'extension/activity-sync.cjs').read_bytes() + b'\n' + activity_source.encode('utf-8')
            if extra:
                changed.update(extra)
            for name, data in changed.items():
                parts = name.split('/')
                if any(part in ('', '.', '..') or '\\' in part for part in parts) or not isinstance(data, bytes):
                    raise ValueError('Invalid patch entry')
                parent = header
                for part in parts[:-1]:
                    parent = parent['files'].setdefault(part, {'files': {}})
                item = parent['files'].setdefault(parts[-1], {})
                if item.get('unpacked') or 'link' in item:
                    raise ValueError('Cannot replace unpacked/linked member: ' + name)
                item['size'] = len(data)
                item['integrity'] = digest(data, item.get('integrity', {}).get('blockSize', 4194304))
            offset = 0
            for name, item in entries(header):
                if item.get('unpacked') or 'link' in item:
                    continue
                if not isinstance(item['size'], int) or item['size'] < 0:
                    raise ValueError('Invalid member size')
                item['offset'] = str(offset)
                offset += item['size']
            raw = json.dumps(header, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            padding = (-len(raw)) % 4
            payload = struct.pack('<II', 4 + len(raw) + padding, len(raw)) + raw + b'\0' * padding
            with temp.open('xb') as dst:
                dst.write(struct.pack('<II', 4, len(payload)))
                dst.write(payload)
                for name, item in entries(header):
                    if item.get('unpacked') or 'link' in item:
                        continue
                    if name in changed:
                        dst.write(changed[name])
                    else:
                        entry = original[name]
                        start, remaining = int(entry['offset']), entry['size']
                        if start < 0 or base + start + remaining > archive_size:
                            raise ValueError('Invalid archive member bounds: ' + name)
                        src.seek(base + start)
                        while remaining:
                            data = src.read(min(1048576, remaining))
                            if not data:
                                raise RuntimeError('Unexpected end of original archive')
                            dst.write(data)
                            remaining -= len(data)
                dst.flush()
                os.fsync(dst.fileno())
        with temp.open('rb') as check:
            built, built_base = read_index(check)
            all_entries = dict(entries(built))
            for name, data in changed.items():
                item = all_entries[name]
                check.seek(built_base + int(item['offset']))
                if check.read(item['size']) != data:
                    raise RuntimeError('Patch verification failed: ' + name)
        os.replace(temp, target)
        return list(changed)
    finally:
        temp.unlink(missing_ok=True)


def source_version(source):
    archive = source/'resources/app.asar'
    if not archive.is_file() or not (source/'ChatGPT.exe').is_file():
        raise ValueError('Supported Codex installation not found. Use --source with its app directory.')
    with archive.open('rb') as file:
        header, base = read_index(file)
        entry = dict(entries(header))['package.json']
        size, offset = entry['size'], int(entry['offset'])
        if entry.get('unpacked') or 'link' in entry or not isinstance(size, int) or not 0 <= size <= MAX_HEADER_BYTES or offset < 0:
            raise ValueError('Invalid package metadata')
        if base + offset + size > archive.stat().st_size:
            raise ValueError('Truncated package metadata')
        file.seek(base + offset)
        value = json.loads(file.read(size))['version']
        if not isinstance(value, str) or not value:
            raise ValueError('Invalid app version')
        return value


def validate_source(source):
    if source_version(source) != SUPPORTED_APP_VERSION:
        raise ValueError('Unsupported app version. This patch supports ' + SUPPORTED_APP_VERSION + ' only.')


def prepare_config(directory):
    for filename, data in [('labels.json', (directory/'labels.example.json').read_bytes()),
                           ('assignments.json', b'{"schemaVersion":1,"assignments":{}}\n')]:
        try:
            with (directory/filename).open('xb') as file:
                file.write(data)
        except FileExistsError:
            pass


def file_hash(file):
    with file.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def prepare_runtime(source, root=ROOT, *, destination=None, progress=None, refresh=False):
    source, root = Path(source).resolve(), Path(root).resolve()
    target = Path(destination).resolve() if destination else root/'runtime/app'
    if target.parent != root/'runtime' or target.name in ('', '.', '..'):
        raise ValueError('Runtime destination must remain inside the installation runtime directory.')
    if target.exists():
        raise ValueError('runtime/app already exists. Close Labels and move it to a backup directory before rebuilding.')
    # Reject both nested directions to avoid recursive copying or copying the app into itself.
    if source == target or source in target.parents or target in source.parents or root == source or source in root.parents:
        raise ValueError('The source installation must be outside the output runtime directory tree.')
    previous = None
    if refresh:
        if source != root/'runtime/app':
            raise ValueError('Refresh requires the current installation runtime.')
        previous = json.loads((source/'codex-labels-build.json').read_text(encoding='utf-8'))
        if previous.get('version') != 3 or Path(previous.get('configPath', '')).resolve() != root/'labels.json' or previous.get('patchedAsarSha256') != file_hash(source/'resources/app.asar'):
            raise ValueError('Current runtime verification failed.')
    validate_source(source)
    prepare_config(root)
    source_hash = file_hash(source/'resources/app.asar')
    stage = root/'runtime'/('.staging-' + uuid.uuid4().hex)
    stage.parent.mkdir(parents=True, exist_ok=True)
    try:
        if progress: progress('앱 파일을 준비하고 있습니다', 25)
        # Do not copy the ASAR only to overwrite it immediately. Unpacked resources remain intact.
        shutil.copytree(source, stage, ignore=lambda directory, names:
                        ['app.asar'] if Path(directory) == source/'resources' and 'app.asar' in names else [])
        if progress: progress('라벨 기능을 설치하고 검증하고 있습니다', 65)
        files = build_asar(source/'resources/app.asar', stage/'resources/app.asar', root, refresh=refresh)
        if file_hash(source/'resources/app.asar') != source_hash:
            raise RuntimeError('The installed app changed during the build. Retry with a stable installation.')
        manifest = {'accountHostProtocol': 1, 'version': 3, 'sourcePackage': source.parent.name, 'sourceAppVersion': SUPPORTED_APP_VERSION, 'sourceAsarSha256': source_hash,
                    'patchedAsarSha256': file_hash(stage/'resources/app.asar'), 'changedArchiveFiles': files,
                    'configPath': str(root/'labels.json'), 'originalInstallModified': False,
                    'liveAppActivated': False, 'launchMode': 'side-by-side', 'nativeNotificationClickVerified': False}
        if previous:
            manifest.update(sourcePackage=previous.get('sourcePackage'), sourceAsarSha256=previous.get('sourceAsarSha256'), basePreserved=True)
        # Stage the manifest too; a failure before publication leaves no half-built runtime/app.
        (stage/'codex-labels-build.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding='utf-8')
        stage.rename(target)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    if destination is None:
        (root/'build-manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding='utf-8')
    return target, files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=SOURCE,
                        help='Installed Codex app directory containing ChatGPT.exe and resources/app.asar.')
    args = parser.parse_args()
    try:
        target, files = prepare_runtime(args.source)
    except (ValueError, KeyError, OSError, RuntimeError, struct.error) as error:
        raise SystemExit(str(error)) from error
    print(json.dumps({'built': str(target), 'patchedFiles': len(files), 'originalInstallModified': False}), flush=True)


if __name__ == '__main__':
    main()
