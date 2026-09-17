"""New runtime packaging tests, with explicit synthetic legacy modules."""
import hashlib
import io
import json
from pathlib import Path
import shutil
import struct
import tempfile
import unittest
from unittest.mock import patch

from test_prepare_runtime import builder, read_archive, write_archive
SOURCE_ROOT = Path(__file__).resolve().parents[1]


class NotificationBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='labels-build-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        # Exercise UTF-8 manifest paths even when the user/temp path is ASCII-only.
        self.project = self.root/'라벨 프로젝트'
        extension = self.project/'extension'
        extension.mkdir(parents=True)
        # These tests exercise new modules + packaging, not the legacy label UI/store.
        for name in ['main.cjs', 'preload.js', *builder.EXTRA_EXTENSION_FILES]:
            shutil.copyfile(SOURCE_ROOT/'extension'/name, extension/name)
        (extension/'renderer.js').write_text('/* synthetic legacy renderer */', encoding='utf-8')
        (extension/'store.cjs').write_text('/* synthetic legacy store */', encoding='utf-8')
        (self.project/'labels.example.json').write_text('{"synthetic":true}', encoding='utf-8')
        root_patch = patch.object(builder, 'ROOT', self.project)
        root_patch.start()
        self.addCleanup(root_patch.stop)
        self.source = self.root/'installed/app'
        self.archive = self.source/'resources/app.asar'
        self.files = {
            'package.json': json.dumps({'version': builder.SUPPORTED_APP_VERSION}).encode(),
            '.vite/build/early-bootstrap.js': b'/* original bootstrap */',
            '.vite/build/preload.js': b'/* original preload */',
            'unchanged.bin': b'original\x00payload'
        }
        write_archive(self.archive, self.files)
        (self.source/'ChatGPT.exe').write_bytes(b'fixture-only')

    def test_new_modules_are_packaged_in_isolated_namespace_with_correct_integrity(self):
        target = self.root/'patched.asar'
        names = builder.build_asar(self.archive, target, self.project)
        result = read_archive(target)
        self.assertEqual(len(names), 10)
        for name in builder.EXTRA_EXTENSION_FILES:
            data, meta = result['.vite/build/codex-labels/' + name]
            self.assertEqual(data, (SOURCE_ROOT/'extension'/name).read_bytes())
            self.assertEqual(meta['integrity']['hash'], hashlib.sha256(data).hexdigest())
        self.assertEqual(result['unchanged.bin'][0], self.files['unchanged.bin'])

    def test_same_source_target_is_rejected_without_altering_original(self):
        before = self.archive.read_bytes()
        with self.assertRaisesRegex(ValueError, 'never be the target'):
            builder.build_asar(self.archive, self.archive, self.project)
        self.assertEqual(before, self.archive.read_bytes())

    def test_corrupt_header_is_rejected_before_unbounded_allocation(self):
        for data in [b'abc', struct.pack('<IIII', 4, 0xffffffff, 0, 0), struct.pack('<IIII', 4, 12, 8, 99)]:
            with self.assertRaises(ValueError):
                builder.read_index(io.BytesIO(data))

    def test_failed_patch_removes_temp_and_preserves_existing_target(self):
        target = self.root/'patched.asar'
        target.write_bytes(b'previous')
        with patch.object(builder.os, 'replace', side_effect=OSError('simulated rename failure')):
            with self.assertRaises(OSError):
                builder.build_asar(self.archive, target, self.project)
        self.assertEqual(target.read_bytes(), b'previous')
        self.assertEqual(list(self.root.glob('patched.asar.tmp-*')), [])

    def test_successful_staged_build_publishes_receipt_but_no_false_live_verification(self):
        before = self.archive.read_bytes()
        target, names = builder.prepare_runtime(self.source, self.project)
        self.assertEqual(len(names), 10)
        self.assertTrue((target/'resources/app.asar').is_file())
        receipt = json.loads((target/'codex-labels-build.json').read_text(encoding='utf-8'))
        self.assertEqual(receipt['version'], 3)
        self.assertEqual(receipt['configPath'], str(self.project.resolve()/'labels.json'))
        published = json.loads((self.project/'build-manifest.json').read_text(encoding='utf-8'))
        self.assertEqual(published, receipt)
        self.assertFalse(receipt['nativeNotificationClickVerified'])
        self.assertFalse(receipt['originalInstallModified'])
        self.assertEqual(before, self.archive.read_bytes())
        self.assertEqual(list((self.project/'runtime').glob('.staging-*')), [])

    def test_failed_staged_build_does_not_publish_incomplete_runtime(self):
        with patch.object(builder, 'build_asar', side_effect=RuntimeError('synthetic build failure')):
            with self.assertRaises(RuntimeError):
                builder.prepare_runtime(self.source, self.project)
        self.assertFalse((self.project/'runtime/app').exists())
        self.assertEqual(list((self.project/'runtime').glob('.staging-*')), [])

    def test_existing_runtime_and_user_settings_are_not_overwritten(self):
        target, _ = builder.prepare_runtime(self.source, self.project)
        before = (target/'resources/app.asar').read_bytes()
        (self.project/'labels.json').write_text('preserve-custom', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            builder.prepare_runtime(self.source, self.project)
        self.assertEqual((target/'resources/app.asar').read_bytes(), before)
        self.assertEqual((self.project/'labels.json').read_text(encoding='utf-8'), 'preserve-custom')

    def test_source_inside_target_is_rejected(self):
        with self.assertRaises(ValueError):
            builder.prepare_runtime(self.project/'runtime/app/inside', self.project)

    def test_source_change_during_build_aborts_publication(self):
        original_build = builder.build_asar
        def changing_build(*args, **kwargs):
            result = original_build(*args, **kwargs)
            with self.archive.open('ab') as file:
                file.write(b'changed-installation')
            return result
        with patch.object(builder, 'build_asar', side_effect=changing_build):
            with self.assertRaisesRegex(RuntimeError, 'changed during the build'):
                builder.prepare_runtime(self.source, self.project)
        self.assertFalse((self.project/'runtime/app').exists())

    def test_patch_entry_path_traversal_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Invalid patch entry'):
            builder.build_asar(self.archive, self.root/'bad.asar', self.project, extra={'../escape': b'bad'})
        self.assertFalse((self.root/'bad.asar').exists())


if __name__ == '__main__':
    unittest.main()
