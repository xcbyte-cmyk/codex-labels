"""Read public releases and stage a verified, strictly allowlisted Windows update.

Never executes downloaded code, replaces the running helper, or touches user data.
The desktop main process installs staged files after this helper has exited.
"""
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
import zipfile

REPO = 'xcbyte-cmyk/codex-labels'
API = f'https://api.github.com/repos/{REPO}/releases/latest'
MAX_DOWNLOAD = 40 * 1024 * 1024
FILES = {'CodexLabelsHelper.exe', 'build-info.json', '설치.cmd', '실행.cmd',
         '사용안내.txt', 'PYTHON-LICENSE.txt', 'PYINSTALLER-LICENSE.txt'}


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r'v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', value):
        raise ValueError('정식 버전 번호를 확인할 수 없습니다.')
    return tuple(int(part) for part in value.removeprefix('v').split('.'))


def safe_url(url):
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443)
            or parsed.hostname not in {'api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}):
        raise ValueError('허용되지 않은 업데이트 다운로드 주소입니다.')
    return url


class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, safe_url(newurl))


def fetch(url, limit):
    request = Request(safe_url(url), headers={'User-Agent': 'Codex-Labels-Updater', 'Accept': 'application/vnd.github+json' if url == API else 'application/octet-stream'})
    try:
        with build_opener(SafeRedirect()).open(request, timeout=20) as response:
            safe_url(response.url)
            length = response.headers.get('Content-Length')
            if length and int(length) > limit:
                raise ValueError('업데이트 파일이 허용 크기를 초과합니다.')
            chunks, size, deadline = [], 0, time.monotonic() + 120
            while True:
                block = response.read(min(65536, limit + 1 - size))
                if not block:
                    return b''.join(chunks)
                size += len(block)
                if size > limit or time.monotonic() > deadline:
                    raise ValueError('다운로드 크기 또는 대기 시간을 초과했습니다. 다시 시도해 주세요.')
                chunks.append(block)
    except HTTPError as error:
        if error.code == 404 and url == API:
            return b'null'
        raise RuntimeError('업데이트 서버에 연결하지 못했습니다. 잠시 후 다시 확인해 주세요.') from error
    except (URLError, TimeoutError, OSError) as error:
        raise RuntimeError('네트워크 연결을 확인한 뒤 다시 시도해 주세요.') from error


def release(current, read=fetch):
    data = json.loads(read(API, 1024 * 1024))
    result = {'currentVersion': current, 'latestVersion': current, 'available': False}
    if data is None:
        return result, None
    if not isinstance(data, dict) or data.get('draft') or data.get('prerelease'):
        raise ValueError('정식 릴리스 정보를 확인할 수 없습니다.')
    tag = data.get('tag_name')
    latest = version(tag)
    result['latestVersion'] = tag.removeprefix('v')
    if latest <= version(current):
        return result, None
    name = f'Codex-Labels-v{result["latestVersion"]}-windows-x64.zip'
    if not isinstance(data.get('assets'), list):
        raise ValueError('릴리스 파일 목록을 확인할 수 없습니다.')
    assets = [a for a in data['assets'] if isinstance(a, dict) and a.get('name') == name]
    if len(assets) != 1:
        raise ValueError('이 릴리스에 Windows 업데이트 파일이 없습니다.')
    asset = assets[0]
    expected_url = f'https://github.com/{REPO}/releases/download/{tag}/{name}'
    if (asset.get('browser_download_url') != expected_url
            or not isinstance(asset.get('digest'), str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', asset['digest'])
            or type(asset.get('size')) is not int or not 0 < asset['size'] <= MAX_DOWNLOAD):
        raise ValueError('다운로드 파일의 출처 또는 검증 정보를 확인할 수 없습니다.')
    result['available'] = True
    return result, asset


def unpack(data, expected_version, supported_version):
    installed_versions = {supported_version} if isinstance(supported_version, str) else set(supported_version)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = archive.infolist()
        names = [item.filename for item in members]
        if (len(names) != len(set(names)) or set(names) - FILES
                or not {'CodexLabelsHelper.exe', 'build-info.json'} <= set(names)
                or sum(item.file_size for item in members) > 80 * 1024 * 1024
                or any(item.is_dir() or item.flag_bits & 1 or ((item.external_attr >> 16) & 0o170000) == 0o120000 for item in members)):
            raise ValueError('업데이트 ZIP의 파일 구성이 올바르지 않습니다.')
        info = json.loads(archive.read('build-info.json'))
        if (not isinstance(info, dict) or info.get('version') != expected_version
                or not isinstance(info.get('supportedAppVersion'), str) or info['supportedAppVersion'] not in installed_versions
                or info.get('containsCodexBinaries') is not False
                or not isinstance(info.get('sourceCommit'), str) or not re.fullmatch(r'[0-9a-f]{40}', info['sourceCommit'])):
            raise ValueError('현재 Codex와 호환되지 않는 업데이트입니다. 기존 버전을 유지합니다.')
        helper = archive.read('CodexLabelsHelper.exe')
        if not helper.startswith(b'MZ'):
            raise ValueError('올바른 Windows 실행 파일이 아닙니다.')
        return {'CodexLabelsHelper.exe': helper, 'build-info.json': archive.read('build-info.json')}


def stage(root, current, supported_version, read=fetch):
    status, asset = release(current, read)
    if asset is None:
        return status
    data = read(asset['browser_download_url'], MAX_DOWNLOAD)
    if len(data) != asset['size'] or hashlib.sha256(data).hexdigest() != asset['digest'][7:]:
        raise ValueError('다운로드 검증에 실패했습니다. 현재 버전은 변경하지 않았습니다.')
    try:
        files = unpack(data, status['latestVersion'], supported_version)
    except (zipfile.BadZipFile, KeyError) as error:
        raise ValueError('업데이트 압축 파일이 손상되었습니다. 다시 다운로드해 주세요.') from error
    root = Path(root).resolve()
    updates = root/'.updates'
    if updates.resolve() != updates:
        raise ValueError('업데이트 폴더가 다른 경로로 연결되어 있습니다.')
    updates.mkdir(exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix='stage-', dir=updates))
    try:
        for name, content in files.items():
            (directory/name).write_bytes(content)
        return {**status, 'stagedDirectory': directory.name,
                'hashes': {name: hashlib.sha256(content).hexdigest() for name, content in files.items()}}
    except Exception:
        shutil.rmtree(directory)
        raise
