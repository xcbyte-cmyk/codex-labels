import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from test_prepare_runtime import builder
import account_profiles as profiles
import account_cleanup as cleanup
import windows_helper as host

class SharedAccountTests(unittest.TestCase):
    def test_shared_store_contract_and_target_only_delete(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'LOCALAPPDATA': str(Path(tmp).resolve())}):
            root = profiles.shared_root()
            a = profiles.create(root, 'A'); b = profiles.create(root, 'B')
            _, directory, profile, env = profiles.launch_context(root, a['id'], {'LOCALAPPDATA': os.environ['LOCALAPPDATA'], 'CHATGPT_TOKEN':'wrong','NODE_OPTIONS':'wrong'})
            self.assertNotIn('CHATGPT_TOKEN', env); self.assertNotIn('NODE_OPTIONS', env)
            module = Path(profiles.__file__).parent/'extension/account-profile.cjs'
            code = "const m=require(process.argv[1]); const x=JSON.parse(process.argv[2]);console.log(JSON.stringify(m.resolveAccount('/unused',x.argv,x.env)));"
            args = ['--codex-labels-account='+a['id'], '--codex-labels-account-protocol=1']
            result = subprocess.run(['node','-e',code,str(module),json.dumps({'argv':args,'env':env})],capture_output=True,text=True,encoding='utf-8',check=True)
            value=json.loads(result.stdout)
            self.assertEqual(Path(value['directory']), directory)
            self.assertEqual(Path(value['home']), directory/'codex-home')
            cleanup.delete_account(root,a['id'],stop=lambda *_:0)
            self.assertFalse(directory.exists())
            self.assertTrue(profiles.account_path(root,b['id']).exists())
            result = subprocess.run(['node','-e',code,str(module),json.dumps({'argv':args,'env':env})],capture_output=True)
            self.assertNotEqual(result.returncode,0)

    def test_old_runtime_is_rejected_before_profile_creation(self):
        from contextlib import nullcontext
        with tempfile.TemporaryDirectory() as tmp, patch.object(host,'preparation_lock',return_value=nullcontext()), patch.object(host,'require_ready',return_value=Path(tmp)/'ChatGPT.exe'), patch.object(host,'read_receipt',return_value={}):
            with self.assertRaisesRegex(RuntimeError,'연결 규칙'):
                host.launch_account(Path(tmp),'a'*32,shared=True)
            self.assertEqual(list(Path(tmp).iterdir()),[])
