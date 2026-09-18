"""Account-window metadata. No credentials are read, copied or exported here."""
import json
import os
from pathlib import Path
import re
import uuid
import tomllib


def account_path(root, account_id):
    if not isinstance(account_id, str) or not re.fullmatch(r'[0-9a-f]{32}', account_id):
        raise ValueError('올바르지 않은 계정 창 ID입니다.')
    root = Path(root).resolve()
    target = root/'accounts'/account_id
    if target.resolve() != target:
        raise ValueError('계정 폴더에 외부 경로 연결을 사용할 수 없습니다.')
    return target


def read(root, account_id):
    directory = account_path(root, account_id)
    value = json.loads((directory/'account.json').read_text(encoding='utf-8'))
    if value.get('version') != 1 or value.get('id') != account_id:
        raise ValueError('계정 창 설정이 손상되었습니다.')
    name = value.get('name')
    if not isinstance(name, str) or not 1 <= len(name) <= 40 or any(ord(c) < 32 for c in name):
        raise ValueError('계정 창 이름이 올바르지 않습니다.')
    for child in ('user-data', 'codex-home'):
        if (directory/child).resolve() != directory/child:
            raise ValueError('계정 저장소에 외부 경로 연결을 사용할 수 없습니다.')
    return {'version': 1, 'id': account_id, 'name': name}


def deletion_marker(root, account_id):
    directory = account_path(root, account_id)
    return directory.parent/('.delete-' + account_id + '.json')


def pending_deletion(root, account_id):
    marker = deletion_marker(root, account_id)
    if not marker.exists(): return None
    if marker.is_symlink(): raise ValueError('삭제 기록의 외부 경로 연결은 지원하지 않습니다.')
    value = json.loads(marker.read_text(encoding='utf-8'))
    if value.get('version') != 1 or value.get('id') != account_id or not isinstance(value.get('name'), str):
        raise ValueError('계정 삭제 기록을 확인할 수 없습니다.')
    return {**value, 'deleting': True}


def list_accounts(root):
    result = {}
    for directory in sorted((Path(root)/'accounts').glob('*')):
        if directory.is_dir() and re.fullmatch(r'[0-9a-f]{32}', directory.name):
            result[directory.name] = pending_deletion(root, directory.name) or read(root, directory.name)
    for marker in sorted((Path(root)/'accounts').glob('.delete-*.json')):
        account_id = marker.name[8:-5]
        result[account_id] = pending_deletion(root, account_id)
    return list(result.values())


def create(root, name):
    name = name.strip()
    if not 1 <= len(name) <= 40 or any(ord(c) < 32 for c in name):
        raise ValueError('계정 창 이름은 1~40자로 입력하세요.')
    if any(item['name'].casefold() == name.casefold() for item in list_accounts(root)):
        raise ValueError('같은 이름의 계정 창이 있습니다.')
    account_id = uuid.uuid4().hex
    directory = account_path(root, account_id)
    directory.mkdir(parents=True, exist_ok=False)
    value = {'version': 1, 'id': account_id, 'name': name}
    # Each UUID has its own file: simultaneous creates cannot lose another entry.
    with (directory/'account.json').open('x', encoding='utf-8') as file:
        json.dump(value, file, ensure_ascii=False, indent=2)
    return value


def launch_context(root, account_id, inherited=None):
    if pending_deletion(root, account_id):
        raise ValueError('삭제가 완료되지 않은 계정 창입니다. 삭제를 다시 실행하세요.')
    value = read(root, account_id)
    directory = account_path(root, account_id)
    home, profile = directory/'codex-home', directory/'user-data'
    home.mkdir(exist_ok=True); profile.mkdir(exist_ok=True)
    config = home/'config.toml'
    if not config.exists():
        with config.open('x', encoding='utf-8') as file:
            file.write('cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n')
    settings = tomllib.loads(config.read_text(encoding='utf-8'))
    if settings.get('cli_auth_credentials_store') != 'file' or settings.get('forced_login_method') != 'chatgpt':
        raise ValueError('계정별 창은 파일 로그인 저장소와 ChatGPT 로그인이 필요합니다. 계정 config.toml을 확인하세요.')
    env = dict(os.environ if inherited is None else inherited)
    # Inherited host routing, tokens, alternate providers and another task's
    # identity must not redirect this account window to the parent's account.
    for key in list(env):
        upper = key.upper()
        if upper.startswith(('CODEX_', 'OPENAI_', 'AZURE_OPENAI_', '_PYI_', 'ELECTRON_')):
            del env[key]
    env.update(CODEX_HOME=str(home), CODEX_SQLITE_HOME=str(home),
               CODEX_ELECTRON_USER_DATA_PATH=str(profile), CODEX_APP_SERVER_FORCE_CLI='1',
               CODEX_LABELS_ACCOUNT_ID=account_id, CODEX_LABELS_LAUNCH_TOKEN=uuid.uuid4().hex)
    return value, directory, profile, env
