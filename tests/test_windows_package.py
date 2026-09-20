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
                self.assertEqual(set(archive.namelist()), {package.HELPER_NAME, '설치.cmd', '실행.cmd', '계정별 실행.cmd',
                    '사용안내.txt', 'build-info.json', 'PYTHON-LICENSE.txt'})
                info = json.loads(archive.read('build-info.json'))
                self.assertFalse(info['containsCodexBinaries'])
                self.assertEqual(info['sourceCommit'], 'a'*40)
                self.assertEqual(info['packageSchemaVersion'], 1)
                self.assertEqual(set(info['updateFiles']), {'CodexLabelsHelper.exe', 'build-info.json'})

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
            local = run('update-status')
            self.assertEqual(local['currentVersion'], package.VERSION)
            self.assertEqual(local['downloadedVersion'], package.VERSION)
            self.assertFalse(local['pendingRestart'])
            self.assertIn(run('codex-status')['state'], ['same', 'changed', 'unavailable'])
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
            # Probe with the OS Unicode reader: WScript.Shell also fails to read
            # Unicode links on English Windows, even when the .lnk is valid.
            script = """
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ProbeLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, IntPtr data, uint flags);
    void GetIDList(out IntPtr id);
    void SetIDList(IntPtr id);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string value);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string value);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string value);
}
public static class ShortcutProbe {
    public static string[] Read(string path, bool replaceArguments) {
        object instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046")));
        try {
            var file = (IPersistFile)instance; file.Load(path, 0);
            var link = (ProbeLinkW)instance;
            var target = new StringBuilder(32768); var arguments = new StringBuilder(32768);
            link.GetPath(target, target.Capacity, IntPtr.Zero, 4);
            link.GetArguments(arguments, arguments.Capacity);
            if (replaceArguments) { link.SetArguments("foreign"); file.Save(path, true); }
            return new string[] { target.ToString(), arguments.ToString() };
        } finally { Marshal.FinalReleaseComObject(instance); }
    }
}
'@
[ShortcutProbe]::Read($env:LABELS_TEST_LINK, ($env:LABELS_TEST_REPLACE -eq '1')) | ConvertTo-Json -Compress
"""
            value = json.loads(powershell(script, {'LABELS_TEST_LINK': str(link)}))
            self.assertEqual(Path(value[0]).resolve(), exe.resolve())
            self.assertEqual(value[1], 'launch')
            powershell(script, {'LABELS_TEST_LINK': str(link), 'LABELS_TEST_REPLACE': '1'})
            with self.assertRaisesRegex(RuntimeError, '다른 실행본'):
                create_shortcut(root, link)


if __name__ == '__main__':
    unittest.main()
