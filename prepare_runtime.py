"""Build a separate Codex runtime. Never changes WindowsApps or its permissions."""
import argparse, copy, hashlib, json, os, shutil, struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VERSION = 'OpenAI.Codex_26.911.7940.0_x64__2p2nqsd0c76g0'
SOURCE = Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'WindowsApps' / VERSION / 'app'
MARKER = b'// codex-labels-v1'
SUPPORTED_APP_VERSION = '26.911.61220'

def entries(header, prefix=''):
    for name, item in header.get('files', {}).items():
        key = prefix + name
        if 'files' in item:
            yield from entries(item, key + '/')
        else:
            yield key, item

def read_index(file):
    file.seek(0)
    _, size, _, length = struct.unpack('<IIII', file.read(16))
    return json.loads(file.read(length)), 8 + size

def digest(data, block=4194304):
    return {'algorithm':'SHA256', 'hash':hashlib.sha256(data).hexdigest(), 'blockSize':block,
            'blocks':[hashlib.sha256(data[i:i+block]).hexdigest() for i in range(0,len(data),block)]}

def build_asar(source, target, config_directory, extra=None):
    with source.open('rb') as src:
        header, base = read_index(src)
        original = dict(entries(copy.deepcopy(header)))
        def read(name):
            entry = original[name]
            src.seek(base + int(entry['offset']))
            return src.read(entry['size'])
        if json.loads(read('package.json'))['version'] != SUPPORTED_APP_VERSION:
            raise RuntimeError('Unsupported app version. Inspect the new version before patching.')
        early = '.vite/build/early-bootstrap.js'; preload = '.vite/build/preload.js'
        if MARKER in read(early) or MARKER in read(preload):
            raise RuntimeError('The source is already patched; use the unmodified installed app.')
        changed = {
            early: MARKER+b'\nrequire("./codex-labels-main.cjs");\n'+read(early),
            preload: read(preload)+b'\n'+MARKER+b'\n'+(ROOT/'extension/preload.js').read_bytes(),
            '.vite/build/codex-labels-main.cjs': (ROOT/'extension/main.cjs').read_bytes(),
            '.vite/build/codex-labels-store.cjs': (ROOT/'extension/store.cjs').read_bytes(),
            '.vite/build/codex-labels-renderer.js': (ROOT/'extension/renderer.js').read_bytes(),
            '.vite/build/codex-labels-location.json': json.dumps({'configDirectory':str(config_directory)},ensure_ascii=False).encode('utf-8')
        }
        if extra:
            changed.update(extra)
        for name,data in changed.items():
            parts=name.split('/')
            parent=header
            for part in parts[:-1]:
                parent=parent['files'][part]
            item = parent['files'].setdefault(parts[-1], {})
            item['size'] = len(data)
            item['integrity'] = digest(data, item.get('integrity',{}).get('blockSize',4194304))
        offset = 0
        for name,item in entries(header):
            if item.get('unpacked') or 'link' in item: continue
            item['offset'] = str(offset); offset += item['size']
        raw = json.dumps(header,ensure_ascii=False,separators=(',',':')).encode('utf-8')
        padding = (-len(raw)) % 4
        pickle_header = struct.pack('<II',4+len(raw)+padding,len(raw))+raw+b'\0'*padding
        temp = target.with_suffix('.asar.tmp')
        with temp.open('wb') as dst:
            dst.write(struct.pack('<II',4,len(pickle_header)));dst.write(pickle_header)
            for name,item in entries(header):
                if item.get('unpacked') or 'link' in item: continue
                if name in changed: dst.write(changed[name])
                else:
                    entry=original[name]; src.seek(base+int(entry['offset']))
                    remaining=entry['size']
                    while remaining:
                        data=src.read(min(1048576,remaining))
                        if not data: raise RuntimeError('Unexpected end of original archive')
                        dst.write(data);remaining-=len(data)
        with temp.open('rb') as check:
            built,built_base=read_index(check); all_entries=dict(entries(built))
            for name,data in changed.items():
                item=all_entries[name];check.seek(built_base+int(item['offset']))
                if check.read(item['size'])!=data: raise RuntimeError('Patch verification failed: '+name)
        os.replace(temp,target)
        return list(changed)

def validate_source(source):
    archive = source/'resources/app.asar'
    if not archive.is_file() or not (source/'ChatGPT.exe').is_file():
        raise ValueError('Supported Codex installation not found. Use --source with its app directory.')
    with archive.open('rb') as file:
        header, base = read_index(file)
        entry = dict(entries(header))['package.json']
        file.seek(base + int(entry['offset']))
        if json.loads(file.read(entry['size']))['version'] != SUPPORTED_APP_VERSION:
            raise ValueError('Unsupported app version. This patch supports ' + SUPPORTED_APP_VERSION + ' only.')

def prepare_config(directory):
    # Never replace the user's colors or assignments on subsequent attempts.
    for filename, data in [
        ('labels.json', (directory/'labels.example.json').read_bytes()),
        ('assignments.json', b'{"schemaVersion":1,"assignments":{}}\n')
    ]:
        try:
            with (directory/filename).open('xb') as file:
                file.write(data)
        except FileExistsError:
            pass

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,default=SOURCE,help='Installed Codex app directory (must contain ChatGPT.exe and resources/app.asar).')
    args=parser.parse_args()
    source=args.source.resolve()
    target=ROOT/'runtime/app'
    if target.exists():raise SystemExit('runtime/app already exists. Existing runtime was preserved.')
    if source == target or source in target.parents:
        raise SystemExit('The source installation must be outside the output runtime directory tree.')
    try:validate_source(source)
    except (ValueError,KeyError,struct.error,json.JSONDecodeError) as error:raise SystemExit(str(error)) from error
    prepare_config(ROOT)
    print('Copying installed runtime to an independent folder...',flush=True)
    shutil.copytree(source,target)
    files=build_asar(source/'resources/app.asar',target/'resources/app.asar',ROOT)
    manifest={'version':2,'sourcePackage':source.parent.name,'sourceAsarSha256':hashlib.file_digest((source/'resources/app.asar').open('rb'),'sha256').hexdigest(),
              'patchedAsarSha256':hashlib.file_digest((target/'resources/app.asar').open('rb'),'sha256').hexdigest(),
              'changedArchiveFiles':files,'configPath':str(ROOT/'labels.json'),'originalInstallModified':False,'liveAppActivated':False,'launchMode':'side-by-side'}
    (ROOT/'build-manifest.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False),encoding='utf-8')
    print(json.dumps({'built':str(target),'patchedFiles':len(files),'originalInstallModified':False}),flush=True)

if __name__=='__main__':main()
