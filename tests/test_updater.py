import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import updater


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.current = '0.2.0'
        self.latest = '0.3.0'
        self.supported = '26.911.61220'
        self.files = {'CodexLabelsHelper.exe': b'MZfixture-not-executed', 'build-info.json': json.dumps({
            'version': self.latest, 'sourceCommit': 'a'*40, 'supportedAppVersion': self.supported,
            'containsCodexBinaries': False}).encode()}

    def bundle(self, files=None):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name, data in (files or self.files).items(): archive.writestr(name, data)
        return stream.getvalue()

    def metadata(self, data, tag=None):
        tag = tag or 'v'+self.latest
        name = f'Codex-Labels-{tag}-windows-x64.zip'
        return {'tag_name': tag, 'draft': False, 'prerelease': False, 'assets': [{
            'name': name, 'size': len(data), 'digest': 'sha256:'+hashlib.sha256(data).hexdigest(),
            'browser_download_url': f'https://github.com/{updater.REPO}/releases/download/{tag}/{name}'}]}

    def reader(self, data=None, metadata=None):
        data = data or self.bundle()
        metadata = metadata or self.metadata(data)
        return lambda url, limit: json.dumps(metadata).encode() if url == updater.API else data

    def test_verified_update_stages_only_helper_and_metadata_and_preserves_personal_files(self):
        for name in ['labels.json', 'assignments.json', 'CodexLabelsHelper.exe']:
            (self.root/name).write_bytes(b'unchanged')
        result = updater.stage(self.root, self.current, self.supported, self.reader())
        staged = self.root/'.updates'/result['stagedDirectory']
        self.assertEqual({p.name for p in staged.iterdir()}, set(self.files))
        self.assertEqual((staged/'CodexLabelsHelper.exe').read_bytes(), self.files['CodexLabelsHelper.exe'])
        for name in ['labels.json', 'assignments.json', 'CodexLabelsHelper.exe']:
            self.assertEqual((self.root/name).read_bytes(), b'unchanged')

    def test_no_downgrade_or_same_version_download_and_no_release(self):
        for tag in ['v0.1.0', 'v0.2.0']:
            data = self.bundle()
            result = updater.stage(self.root, self.current, self.supported, self.reader(data, self.metadata(data, tag)))
            self.assertFalse(result['available'])
        self.assertFalse(updater.release(self.current, lambda *_: b'null')[0]['available'])
        self.assertFalse((self.root/'.updates').exists())

    def test_checksum_mismatch_does_not_stage(self):
        data = self.bundle()
        for corrupt in [data+b'bad',b'XX'+data[2:]]:
            with self.assertRaisesRegex(ValueError, '검증'):
                updater.stage(self.root, self.current, self.supported, self.reader(corrupt, self.metadata(data)))
        self.assertFalse((self.root/'.updates').exists())

    def test_invalid_asset_origin_digest_size_and_prerelease_are_rejected(self):
        for field, value in [('browser_download_url','https://evil.test/file'),('digest',None),('size',updater.MAX_DOWNLOAD+1)]:
            data = self.bundle(); meta = self.metadata(data); meta['assets'][0][field] = value
            with self.assertRaises((ValueError, TypeError)):
                updater.release(self.current, self.reader(data, meta))
        meta = self.metadata(self.bundle()); meta['prerelease'] = True
        with self.assertRaises(ValueError): updater.release(self.current, self.reader(metadata=meta))

    def test_zip_traversal_personal_files_duplicates_and_symlink_rejected(self):
        for name in ['../escape.exe', 'labels.json', 'runtime/app/ChatGPT.exe', 'C:/evil.exe']:
            with self.assertRaises(ValueError): updater.unpack(self.bundle({**self.files,name:b'x'}), self.latest,self.supported)
        stream=io.BytesIO()
        with zipfile.ZipFile(stream,'w') as z:
            for name, data in self.files.items():z.writestr(name,data)
            with self.assertWarns(UserWarning):z.writestr('build-info.json',b'{}')
        with self.assertRaises(ValueError):updater.unpack(stream.getvalue(),self.latest,self.supported)
        stream=io.BytesIO()
        with zipfile.ZipFile(stream,'w') as z:
            info=zipfile.ZipInfo('CodexLabelsHelper.exe');info.external_attr=(0o120777<<16)
            z.writestr(info,b'target');z.writestr('build-info.json',self.files['build-info.json'])
        with self.assertRaises(ValueError):updater.unpack(stream.getvalue(),self.latest,self.supported)

    def test_version_and_codex_compatibility_checked_before_staging(self):
        with self.assertRaisesRegex(ValueError,'호환'):
            updater.stage(self.root,self.current,'unsupported',self.reader())
        with self.assertRaisesRegex(ValueError,'호환'):
            updater.unpack(self.bundle(),'9.0.0',self.supported)
        self.assertFalse((self.root/'.updates').exists())

    def test_new_package_can_support_a_newer_installed_codex_version(self):
        info=json.loads(self.files['build-info.json']);info['supportedAppVersion']='27.100.1'
        self.files['build-info.json']=json.dumps(info).encode()
        result=updater.stage(self.root,self.current,{'27.100.1'},self.reader())
        self.assertTrue(result['available'])

    def test_unsafe_redirects_and_invalid_versions(self):
        for url in ['http://github.com/x','https://evil.test/x','https://github.com.evil.test/x','https://u:p@github.com/x','file:///x']:
            with self.assertRaises(ValueError):updater.safe_url(url)
        for value in ['1.0','v1.2.3-beta','1.0.01',None]:
            with self.assertRaises(ValueError):updater.version(value)
        self.assertGreater(updater.version('v0.10.0'),updater.version('v0.9.9'))

    def test_network_failure_does_not_modify_anything(self):
        with self.assertRaises(RuntimeError):
            updater.stage(self.root,self.current,self.supported,lambda *_: (_ for _ in ()).throw(RuntimeError('offline')))
        self.assertEqual(list(self.root.iterdir()),[])


if __name__ == '__main__': unittest.main()
