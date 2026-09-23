"""Synthetic archive tests; no Codex binaries or account data are needed."""
import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import prepare_runtime as builder


ACTIVITY_BUNDLE = 'webview/assets/app-initial-0a1b2c3d.js'
# Minified shape shared by Codex 26.915 and 26.917 with different local names.
ACTIVITY_SOURCE = (b'async function boot(){$S=await Hx.services}'
    b'function cached(){return t.delete(n),wd(o,n).observeCatalogThreads(e)}'
    b'function live(){if(x){t.set(n,r);return}wd(o,n).observeCatalogThreads(r)}'
    b'function coordinate(){return $S.clientCoordination}')


def write_archive(path, files, activity=True):
    files = dict(files)
    if activity:
        files.setdefault(ACTIVITY_BUNDLE, ACTIVITY_SOURCE)
    header = {'files': {}}
    offset = 0
    for name, data in files.items():
        parent = header
        parts = name.split('/')
        for part in parts[:-1]:
            parent = parent['files'].setdefault(part, {'files': {}})
        parent['files'][parts[-1]] = {
            'size': len(data), 'offset': str(offset), 'integrity': builder.digest(data)
        }
        offset += len(data)
    raw = json.dumps(header, separators=(',', ':')).encode()
    padding = (-len(raw)) % 4
    payload = struct.pack('<II', 4 + len(raw) + padding, len(raw)) + raw + b'\0' * padding
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack('<II', 4, len(payload)) + payload + b''.join(files.values()))


def read_archive(path):
    with path.open('rb') as file:
        header, base = builder.read_index(file)
        result = {}
        for name, entry in builder.entries(header):
            file.seek(base + int(entry['offset']))
            result[name] = (file.read(entry['size']), entry)
        return result


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='codex-labels-builder-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root/'installed'
        self.archive = self.source/'resources/app.asar'
        self.files = {
            'package.json': json.dumps({'version': builder.VERIFIED_APP_VERSION}).encode(),
            '.vite/build/early-bootstrap.js': b'/* synthetic bootstrap */',
            '.vite/build/preload.js': b'/* synthetic preload */',
            'unchanged.txt': b'untouched\x00payload',
        }
        write_archive(self.archive, self.files)
        (self.source/'ChatGPT.exe').write_bytes(b'')

    def test_patch_preserves_source_and_unchanged_members_and_rebuilds_integrity(self):
        before = self.archive.read_bytes()
        target = self.root/'patched.asar'
        changed = builder.build_asar(self.archive, target, self.root/'settings')
        self.assertEqual(self.archive.read_bytes(), before)
        result = read_archive(target)
        self.assertEqual(len(changed), 7 + len(builder.EXTRA_EXTENSION_FILES))
        self.assertEqual(result['unchanged.txt'][0], self.files['unchanged.txt'])
        self.assertTrue(result['.vite/build/early-bootstrap.js'][0].startswith(builder.MARKER))
        self.assertIn(b'codex-labels:save-config', result['.vite/build/preload.js'][0])
        self.assertIn(b'codex-labels:save-config', result['.vite/build/codex-labels-main.cjs'][0])
        self.assertIn(b'codex-labels:vocabulary-summarize', result['.vite/build/preload.js'][0])
        self.assertIn(b'registerVocabulary', result['.vite/build/codex-labels-main.cjs'][0])
        # A copied Windows runtime still needs its bundled local CLI, but
        # forcing CLI transport globally would route SSH hosts into local stdio.
        self.assertIn(b'CODEX_CLI_PATH', result['.vite/build/codex-labels-main.cjs'][0])
        self.assertNotIn(b'CODEX_APP_SERVER_FORCE_CLI', result['.vite/build/codex-labels-main.cjs'][0])
        self.assertNotIn(b'CODEX_APP_SERVER_FORCE_CLI', result['.vite/build/codex-labels/account-profile.cjs'][0])
        for name in ('vocabulary.cjs', 'vocabulary-ipc.cjs', 'vocabulary-renderer.js'):
            self.assertEqual(result['.vite/build/codex-labels/' + name][0], (builder.ROOT/'extension'/name).read_bytes())
        location = json.loads(result['.vite/build/codex-labels-location.json'][0])
        self.assertEqual(location['configDirectory'], str(self.root/'settings'))
        for name in changed:
            data, entry = result[name]
            self.assertEqual(entry['integrity']['hash'], hashlib.sha256(data).hexdigest())
            self.assertEqual(entry['size'], len(data))

    def test_activity_hook_is_discovered_and_never_resumes_tasks(self):
        target = self.root/'patched.asar'
        builder.build_asar(self.archive, target, self.root/'settings')
        content=read_archive(target)[ACTIVITY_BUNDLE][0]
        self.assertIn(b'retainActiveConversation', content)
        self.assertNotIn(b'resumeConversation', content)
        self.assertEqual(content.count(b'__codexLabelsActivitySync.observe(n,'), 2)
        self.assertIn(b'observeCatalogThreads(e),globalThis.__codexLabelsActivitySync.observe(n,e,wd(o,n),$S.clientCoordination)', content)
        self.assertIn(b'observeCatalogThreads(r),globalThis.__codexLabelsActivitySync.observe(n,r,wd(o,n),$S.clientCoordination)', content)

    def test_unknown_or_ambiguous_activity_shape_skips_only_the_optional_hook(self):
        for source in (b'upstream changed', ACTIVITY_SOURCE + b';function extra(){wd(o,n).observeCatalogThreads(z)}',
                       ACTIVITY_SOURCE.replace(b'$S=await Hx.services', b'')):
            self.files[ACTIVITY_BUNDLE] = source
            write_archive(self.archive, self.files)
            target = self.root/'patched.asar'
            changed = builder.build_asar(self.archive, target, self.root)
            self.assertNotIn(ACTIVITY_BUNDLE, changed)
            result = read_archive(target)
            self.assertEqual(result[ACTIVITY_BUNDLE][0], source)
            self.assertTrue(result['.vite/build/early-bootstrap.js'][0].startswith(builder.MARKER))

    def test_missing_activity_bundle_still_builds_labels(self):
        write_archive(self.archive,self.files,activity=False)
        changed = builder.build_asar(self.archive,self.root/'patched.asar',self.root)
        self.assertIn('.vite/build/codex-labels-main.cjs', changed)

    def test_any_well_formed_newer_version_is_accepted(self):
        self.files['package.json'] = b'{"version":"27.100.1"}'
        write_archive(self.archive, self.files)
        self.assertEqual(builder.validate_source(self.source), '27.100.1')
        self.assertIn(ACTIVITY_BUNDLE, builder.build_asar(self.archive, self.root/'patched.asar', self.root))

    def test_missing_bootstrap_structure_is_rejected(self):
        del self.files['.vite/build/preload.js']
        write_archive(self.archive, self.files)
        with self.assertRaisesRegex(ValueError, 'Unsupported app structure'):
            builder.validate_source(self.source)
        with self.assertRaisesRegex(RuntimeError, 'Unsupported app structure'):
            builder.build_asar(self.archive, self.root/'bad.asar', self.root)
        self.assertFalse((self.root/'bad.asar').exists())

    def test_refresh_replaces_previous_activity_hook_once(self):
        first = self.root/'first.asar'
        builder.build_asar(self.archive, first, self.root)
        second = self.root/'second.asar'
        builder.build_asar(first, second, self.root, refresh=True)
        content = read_archive(second)[ACTIVITY_BUNDLE][0]
        self.assertEqual(content.count(b'__codexLabelsActivitySync.observe(n,'), 2)
        self.assertEqual(content.count(b'root.__codexLabelsActivitySync = createActivitySync()'), 1)

    def test_newest_patchable_installation_is_selected(self):
        older = self.root/'older'
        write_archive(older/'resources/app.asar', {**self.files, 'package.json': b'{"version":"26.9.1"}'})
        (older/'ChatGPT.exe').write_bytes(b'')
        broken = self.root/'broken'
        write_archive(broken/'resources/app.asar', {'package.json': b'{"version":"99.0.0"}'})
        (broken/'ChatGPT.exe').write_bytes(b'')
        self.assertEqual(builder.newest_source([older, broken, self.source]), self.source.resolve())
        with self.assertRaisesRegex(ValueError, 'installation not found'):
            builder.newest_source([broken])

    def test_unsupported_version_is_rejected_before_creating_target(self):
        self.files['package.json'] = b'{"version":"unsupported"}'
        write_archive(self.archive, self.files)
        target = self.root/'patched.asar'
        with self.assertRaisesRegex(RuntimeError, 'Unsupported app version'):
            builder.build_asar(self.archive, target, self.root)
        self.assertFalse(target.exists())
        with self.assertRaisesRegex(ValueError, 'Unsupported app version'):
            builder.validate_source(self.source)

    def test_already_patched_archive_is_rejected(self):
        patched = self.root/'patched.asar'
        builder.build_asar(self.archive, patched, self.root)
        target = self.root/'second.asar'
        with self.assertRaisesRegex(RuntimeError, 'already patched'):
            builder.build_asar(patched, target, self.root)
        self.assertFalse(target.exists())

    def test_source_requires_full_installed_runtime(self):
        builder.validate_source(self.source)
        (self.source/'ChatGPT.exe').unlink()
        with self.assertRaisesRegex(ValueError, 'installation not found'):
            builder.validate_source(self.source)

    def test_initial_configuration_is_created_without_overwriting_user_changes(self):
        example = (builder.ROOT/'labels.example.json').read_bytes()
        (self.root/'labels.example.json').write_bytes(example)
        builder.prepare_config(self.root)
        self.assertEqual((self.root/'labels.json').read_bytes(), example)
        self.assertEqual(json.loads((self.root/'assignments.json').read_text())['assignments'], {})
        custom = b'{"custom":"preserve exactly"}'
        assignments = b'{"schemaVersion":1,"assignments":{"project:example":"requested"}}'
        (self.root/'labels.json').write_bytes(custom)
        (self.root/'assignments.json').write_bytes(assignments)
        builder.prepare_config(self.root)
        self.assertEqual((self.root/'labels.json').read_bytes(), custom)
        self.assertEqual((self.root/'assignments.json').read_bytes(), assignments)


if __name__ == '__main__':
    unittest.main()
