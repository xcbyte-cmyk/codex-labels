"""Synthetic ASAR packaging/refresh tests; never needs an installed Desktop."""
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

import prepare_runtime as builder

ROOT = Path(__file__).resolve().parents[1]
NEW_FILES = ('account-switch-profiles.cjs', 'account-session-router.cjs', 'account-switcher.cjs',
             'account-switcher-preload.js', 'account-switcher-renderer.js')


def archive(file, files):
    header = {'files': {}}
    offset = 0
    for name, data in files.items():
        parent = header
        parts = name.split('/')
        for part in parts[:-1]:
            parent = parent['files'].setdefault(part, {'files': {}})
        parent['files'][parts[-1]] = {'offset': str(offset), 'size': len(data)}
        offset += len(data)
    raw = json.dumps(header, separators=(',', ':')).encode()
    padding = (-len(raw)) % 4
    payload = struct.pack('<II', 4 + len(raw) + padding, len(raw)) + raw + b'\0' * padding
    file.write_bytes(struct.pack('<II', 4, len(payload)) + payload + b''.join(files.values()))


def read(file, name):
    with file.open('rb') as handle:
        header, base = builder.read_index(handle)
        item = dict(builder.entries(header))[name]
        handle.seek(base + int(item['offset']))
        return handle.read(item['size'])


class AccountSwitcherBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.payload = self.root / 'payload'
        (self.payload / 'extension').mkdir(parents=True)
        for name in ('main.cjs', 'preload.js', 'store.cjs', 'renderer.js', *builder.EXTRA_EXTENSION_FILES):
            data = (ROOT / 'extension' / name).read_bytes() if name in NEW_FILES else b'// synthetic legacy extension\n'
            (self.payload / 'extension' / name).write_bytes(data)
        self.source = self.root / 'source.asar'
        archive(self.source, {
            'package.json': json.dumps({'version': builder.SUPPORTED_APP_VERSION}).encode(),
            '.vite/build/early-bootstrap.js': b'"use strict";\n',
            '.vite/build/preload.js': b'const originalPreload=true;\n',
            builder.ACTIVITY_BUNDLE: (';'.join(f'{builder.ACTIVITY_CONTROLLER}.observeCatalogThreads({v})' for v in ('e', 'r'))).encode(),
        })

    def build(self, source, target, **kwargs):
        with patch.object(builder, 'ROOT', self.payload):
            return builder.build_asar(source, target, self.root, **kwargs)

    def test_all_modules_shipped_and_original_archive_unchanged(self):
        before = self.source.read_bytes()
        target = self.root / 'target.asar'
        self.build(self.source, target)
        for name in NEW_FILES:
            self.assertIn(name, builder.EXTRA_EXTENSION_FILES)
            self.assertEqual(read(target, '.vite/build/codex-labels/' + name), (ROOT / 'extension' / name).read_bytes())
        self.assertEqual(self.source.read_bytes(), before)
        self.assertIn(b'codexLabelsAccounts', read(target, '.vite/build/preload.js'))

    def test_refresh_does_not_duplicate_preload_bridge(self):
        first, second = self.root / 'first.asar', self.root / 'second.asar'
        self.build(self.source, first)
        self.build(first, second, refresh=True)
        preload = read(second, '.vite/build/preload.js')
        self.assertEqual(preload.count(b"exposeInMainWorld('codexLabelsAccounts'"), 1)
        self.assertEqual(preload.count(builder.MARKER), 1)

    def test_missing_switcher_module_preserves_previous_target(self):
        (self.payload / 'extension/account-switcher.cjs').unlink()
        target = self.root / 'previous.asar'
        target.write_bytes(b'previous-verified-runtime')
        with self.assertRaises(FileNotFoundError):
            self.build(self.source, target)
        self.assertEqual(target.read_bytes(), b'previous-verified-runtime')
        self.assertEqual(list(self.root.glob('previous.asar.tmp-*')), [])


if __name__ == '__main__':
    unittest.main()
