"""macOS archive compatibility without using user data or signing real apps."""
import json
from pathlib import Path
import tempfile
import unittest
from test_prepare_runtime import write_archive, read_archive
from prepare_runtime import build_asar
from prepare_macos import SUPPORTED_VERSION

class MacArchiveTests(unittest.TestCase):
    def test_mac_patch_preserves_sidebar_and_requires_exact_version(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            source, target = root/'source.asar', root/'target.asar'
            files = {'package.json': json.dumps({'version': SUPPORTED_VERSION}).encode(),
                     '.vite/build/early-bootstrap.js': b'original bootstrap',
                     '.vite/build/preload.js': b'original preload',
                     'webview/assets/current-sidebar.js': b'original sidebar'}
            write_archive(source, files, activity=False)
            original = source.read_bytes()
            build_asar(source, target, root/'config', supported_version=SUPPORTED_VERSION, activity=False)
            self.assertEqual(source.read_bytes(), original)
            patched = read_archive(target)
            self.assertEqual(patched['webview/assets/current-sidebar.js'][0], b'original sidebar')
            self.assertIn(b'codex-labels-main.cjs', patched['.vite/build/early-bootstrap.js'][0])
            with self.assertRaisesRegex(RuntimeError, 'Unsupported app version'):
                build_asar(source, root/'bad.asar', root/'config', supported_version='unknown', activity=False)
