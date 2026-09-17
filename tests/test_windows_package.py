"""Package allowlist and opt-in smoke of the actual frozen Windows helper."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

from test_prepare_runtime import builder, write_archive
import package_windows as package


class PackageTests(unittest.TestCase):
    def test_zip_has_only_explicit_distribution_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            exe = root/package.HELPER_NAME; exe.write_bytes(b'fixture')
            license_file = root/'license'; license_file.write_text('fixture', encoding='utf-8')
            output = root/'bundle.zip'
            package.write_zip(exe, output, 'a'*40, [(license_file, 'PYTHON-LICENSE.txt')])
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(set(archive.namelist()), {package.HELPER_NAME, '설치.cmd', '실행.cmd',
                    '사용안내.txt', 'build-info.json', 'PYTHON-LICENSE.txt'})
                info = json.loads(archive.read('build-info.json'))
                self.assertFalse(info['containsCodexBinaries'])
                self.assertEqual(info['sourceCommit'], 'a'*40)

    @unittest.skipUnless(os.environ.get('CODEX_LABELS_PACKAGE_ZIP'), 'Frozen artifact smoke is opt-in')
    def test_frozen_helper_prepares_checks_updates_and_creates_scoped_shortcut(self):
        from windows_helper import create_shortcut, powershell
        with tempfile.TemporaryDirectory(prefix='labels-package-smoke-') as temporary:
            root = Path(temporary)/'한글 설치 경로'
            source = Path(temporary)/'official/app'
            with zipfile.ZipFile(os.environ['CODEX_LABELS_PACKAGE_ZIP']) as archive:
                archive.extractall(root)
            write_archive(source/'resources/app.asar', {
                'package.json': json.dumps({'version': builder.SUPPORTED_APP_VERSION}).encode(),
                '.vite/build/early-bootstrap.js': b'/* bootstrap */',
                '.vite/build/preload.js': b'/* preload */'})
            (source/'ChatGPT.exe').write_bytes(b'never-launch-synthetic')
            exe = root/package.HELPER_NAME
            def run(action):
                result = subprocess.run([str(exe), action, '--source', str(source)], capture_output=True,
                    encoding='utf-8', timeout=120)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                return json.loads(result.stdout.strip().splitlines()[-1])
            self.assertFalse(run('check')['ready'])
            self.assertTrue(run('prepare')['ready'])
            self.assertTrue(run('check')['ready'])
            custom = b'{"custom":"preserved"}'
            (root/'labels.json').write_bytes(custom)
            receipt_path = root/'runtime/app/codex-labels-build.json'
            receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
            receipt['helperPayloadSha256'] = 'old-payload'
            receipt_path.write_text(json.dumps(receipt), encoding='utf-8')
            self.assertTrue(run('prepare')['ready'])
            self.assertEqual((root/'labels.json').read_bytes(), custom)
            self.assertTrue(run('prepare')['alreadyPrepared'])
            link = root/'test shortcut.lnk'
            create_shortcut(root, link)
            self.assertTrue(link.is_file())
            create_shortcut(root, link)  # Same owner is idempotent.
            script = "$s=New-Object -ComObject WScript.Shell; $l=$s.CreateShortcut($env:LABELS_TEST_LINK); " \
                "[pscustomobject]@{Target=$l.TargetPath; Arguments=$l.Arguments} | ConvertTo-Json -Compress"
            value = json.loads(powershell(script, {'LABELS_TEST_LINK': str(link)}))
            self.assertEqual(Path(value['Target']).resolve(), exe.resolve())
            self.assertEqual(value['Arguments'], 'launch')
            powershell("$s=New-Object -ComObject WScript.Shell; $l=$s.CreateShortcut($env:LABELS_TEST_LINK); "
                "$l.Arguments='foreign'; $l.Save()", {'LABELS_TEST_LINK': str(link)})
            with self.assertRaisesRegex(RuntimeError, '다른 실행본'):
                create_shortcut(root, link)


if __name__ == '__main__':
    unittest.main()
