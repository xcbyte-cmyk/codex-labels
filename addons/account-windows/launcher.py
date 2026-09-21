"""Source-mode optional launcher; reuses one installed Labels runtime."""
import argparse
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import windows_helper as host


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--install-root', type=Path, required=True)
    args = parser.parse_args()
    root = args.install_root.resolve()
    host.require_ready(root)
    if host.read_receipt(root).get('accountHostProtocol') != 1 or not host.valid_runtime(root, root/'runtime/app'):
        raise RuntimeError('공통 계정 연결을 지원하는 Labels 실행본이 필요합니다.')
    return host.open_accounts(root)


if __name__ == '__main__':
    raise SystemExit(main())
