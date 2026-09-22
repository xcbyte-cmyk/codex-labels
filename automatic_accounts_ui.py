"""Native account picker. Browser login is required only for registration/renewal.
The UI never claims that a file read or a live PID proves Desktop account usage.
"""
from __future__ import annotations
import argparse
import os
from pathlib import Path
import queue
import threading
import tkinter as tk
from tkinter import ttk, messagebox, simpledialog
from automatic_accounts import (AccountError, Handoff, NativeVerifier,
    Vault, WindowsDesktop, import_existing_accounts, vault_path, workspace_mutex)

MESSAGES = {
    'closing': 'Labels를 정상 종료하고 있습니다. 종료 확인창이 뜨면 확인해 주세요.',
    'activating': '종료를 확인했습니다. 선택한 로그인 정보를 적용하고 있습니다.',
    'reopening': '기존 작업 공간으로 Labels를 다시 실행하고 있습니다.',
    'done': '선택 계정으로 Labels를 다시 실행했습니다.',
    'EXIT_NOT_CONFIRMED': '앱 종료가 확인되지 않았습니다. 인증은 바꾸지 않았습니다. 종료 대화상자를 확인하세요.',
    'NATIVE_REQUEST_FAILED': '네이티브 인증 검증이 실패했습니다. 네트워크를 확인하거나 선택 계정의 로그인 갱신을 누르세요.',
    'LOGIN_REQUIRED': '선택한 계정의 로그인 갱신이 필요합니다.',
    'IDENTITY_MISMATCH': '로그인 계정이 선택한 계정과 다릅니다. 전환을 중단했습니다.',
    'RECOVERY_REQUIRED': '이전 전환이 완료되지 않았습니다. 이전 로그인 복원을 실행하세요.',
    'AUTH_CHANGED_EXTERNALLY': '다른 프로그램이 로그인 정보를 바꿨습니다. 그 정보를 덮어쓰지 않고 중단했습니다.',
    'CANCELLED': '취소했습니다. 진행 중인 로그인 창은 브라우저에서 닫으세요.',
    'REOPEN_FAILED': '선택 계정을 적용했지만 Labels 재실행에 실패했습니다. 앱을 다시 여세요.',
    'ALREADY_OPEN': '같은 작업 공간의 계정 선택기가 이미 열려 있습니다.',
    'WINDOWS_REQUIRED': '이 계정 전환기는 Windows에서만 실행할 수 있습니다.',
    'VAULT_UNAVAILABLE': '저장 계정을 이 Windows 사용자로 복호화하지 못했습니다. 원본 파일을 보존하세요.',
    'MANAGED_CHATGPT_REQUIRED': '현재 로그인은 저장 가능한 ChatGPT 관리형 로그인이 아닙니다. API 키/외부 토큰 로그인은 지원하지 않습니다.',
}

def run(argv=None):
    p = argparse.ArgumentParser(description='Codex Labels 자동 계정 전환')
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--home', type=Path, required=True)
    p.add_argument('--profile', type=Path, required=True)
    p.add_argument('--parent-pid', type=int, default=0)
    p.add_argument('--account-id')
    p.add_argument('--recovery', action='store_true')
    args = p.parse_args(argv)
    ui = tk.Tk(); ui.title('Codex Labels · 계정 전환'); ui.geometry('650x500'); ui.minsize(570, 460)
    if os.name == 'nt':
        # Keep stdout pipe intact: the live parent consumes one fixed quit line.
        import ctypes
        ctypes.windll.kernel32.FreeConsole()
    try:
        with workspace_mutex(args.home):
            desktop = WindowsDesktop(args.root, args.home, args.profile, args.parent_pid, args.account_id)
            vault = Vault(vault_path(args.home))
            verifier = NativeVerifier(desktop.cli, vault)
            app = Picker(ui, args.home, vault, verifier, desktop, recovery=args.recovery)
            ui.mainloop()
        return 0
    except Exception as e:
        code = e.code if isinstance(e, AccountError) else 'START_FAILED'
        messagebox.showerror('계정 전환 중단', MESSAGES.get(code, '실행 조건을 확인하지 못했습니다. [' + code + ']'), parent=ui)
        ui.destroy(); return 1

class Picker:
    def __init__(self, ui, home, vault, verifier, desktop, *, recovery=False):
        self.ui, self.home, self.vault, self.verifier, self.desktop = ui, home, vault, verifier, desktop
        self.events = queue.Queue(); self.completed = False; self.busy = False; self.cancelled = threading.Event(); self.is_switch = False
        outer = ttk.Frame(ui, padding=18); outer.pack(fill='both', expand=True)
        ttk.Label(outer, text='저장된 계정으로 자동 전환', font=('Malgun Gothic', 16, 'bold')).pack(anchor='w')
        ttk.Label(outer, text='계정을 선택하고 전환을 누르면 같은 작업 공간으로 다시 실행합니다.\n전환 버튼을 누르면 선택한 계정으로 기존 대화·코드 문맥을 사용하는 데 동의한 것으로 처리합니다.', wraplength=590).pack(anchor='w', pady=(8, 14))
        self.tree = ttk.Treeview(outer, columns=('name', 'email', 'status'), show='headings', height=7, selectmode='browse')
        self.tree.heading('name', text='이름'); self.tree.heading('email', text='저장 로그인')
        self.tree.heading('status', text='상태'); self.tree.column('status', width=80)
        self.tree.column('name', width=160); self.tree.column('email', width=300); self.tree.pack(fill='both', expand=True)
        buttons = ttk.Frame(outer); buttons.pack(fill='x', pady=8)
        self.add = ttk.Button(buttons, text='계정 추가 · 브라우저 로그인', command=self.add_account); self.add.pack(side='left')
        self.renew = ttk.Button(buttons, text='선택 계정 로그인 갱신', command=self.renew_account); self.renew.pack(side='left', padx=8)
        self.delete = ttk.Button(buttons, text='등록 삭제', command=self.delete_account); self.delete.pack(side='left')
        row = ttk.Frame(outer); row.pack(fill='x', pady=10)
        self.change = ttk.Button(row, text='선택 계정으로 전환 및 재실행', command=self.switch); self.change.pack(side='left')
        self.recover = ttk.Button(row, text='이전 로그인 복원', command=self.restore); self.recover.pack(side='left', padx=8)
        self.cancel = ttk.Button(row, text='로그인 취소', command=self.cancelled.set); self.cancel.pack(side='right')
        self.status = tk.StringVar(value='계정을 선택하세요. 앱 재시작으로 미저장 초안·스크롤은 유지되지 않을 수 있습니다.')
        ttk.Label(outer, textvariable=self.status, wraplength=600).pack(anchor='w', fill='x')
        self.ui.protocol('WM_DELETE_WINDOW', self.close)
        try:
            if not vault.journal.exists(): self.register_existing()
            else: self.status.set(MESSAGES['RECOVERY_REQUIRED'])
            self.refresh()
        except AccountError as e: self.status.set(MESSAGES.get(e.code, '[' + e.code + ']'))
        self.controls(); self.completion_timer = None; self.poll_timer = ui.after(100, self.poll)
    def register_existing(self):
        base = Path(os.environ.get('LOCALAPPDATA', '')) / 'CodexLabels' / 'AccountWindows' / 'accounts'
        self.current_id = import_existing_accounts(self.vault, self.home, base)
    def refresh(self):
        selected = self.tree.selection()
        for row in self.tree.get_children(): self.tree.delete(row)
        for e in self.vault.list():
            current = e['id'] == getattr(self, 'current_id', None)
            self.tree.insert('', 'end', iid=e['id'], values=(e['name'], e['email'], '현재 계정' if current else ''))
        target = selected[0] if selected else getattr(self, 'current_id', None)
        if target and self.tree.exists(target): self.tree.selection_set(target)
    def controls(self):
        pending = self.vault.journal.exists()
        for button in (self.add, self.renew, self.delete, self.change): button.state(['disabled'] if self.busy or pending or self.completed else ['!disabled'])
        self.recover.state(['!disabled'] if pending and not self.busy else ['disabled'])
        self.cancel.state(['!disabled'] if self.busy and not self.is_switch else ['disabled'])
    def selected(self):
        ids = self.tree.selection()
        if not ids: self.status.set('전환할 계정을 선택하세요.'); return None
        return ids[0]
    def start(self, action, switching=False):
        if self.busy: return
        self.busy = True; self.is_switch = switching; self.cancelled.clear(); self.controls()
        def worker():
            try: self.events.put(('result', action()))
            except Exception as e: self.events.put(('error', e.code if isinstance(e, AccountError) else 'OPERATION_FAILED'))
        threading.Thread(target=worker, daemon=False).start()
    def add_account(self):
        name = simpledialog.askstring('계정 이름', '목록에 표시할 이름 (비워두면 이메일 사용)', parent=self.ui)
        if name is None: return
        self.status.set('브라우저에서 추가할 계정으로 로그인하세요. 현재 작업 공간의 로그인은 바꾸지 않습니다.')
        def work():
            c = self.verifier.browser_login(cancelled=self.cancelled.is_set)
            self.vault.save(c, name)
            return '계정을 등록했습니다. 선택 후 전환할 수 있습니다.'
        self.start(work)
    def renew_account(self):
        profile_id = self.selected()
        if not profile_id: return
        name, old = self.vault.get(profile_id)
        self.status.set('브라우저에서 선택한 계정으로 로그인하세요. 다른 계정은 등록 덮어쓰기하지 않습니다.')
        def work():
            c = self.verifier.browser_login(expected=old.identity, cancelled=self.cancelled.is_set)
            self.vault.save(c, name, profile_id)
            return '선택 계정의 로그인을 갱신했습니다. 전환을 다시 누르세요.'
        self.start(work)
    def delete_account(self):
        key = self.selected()
        if key and messagebox.askyesno('등록 삭제', '이 선택기에 저장한 로그인만 삭제합니다. 대화·현재 로그인은 삭제하지 않습니다.', parent=self.ui):
            self.vault.remove(key); self.refresh()
    def switch(self):
        key = self.selected()
        if not key: return
        handoff = Handoff(self.home, self.vault, self.desktop,
                          progress=lambda code: self.events.put(('progress', code)))
        self.start(lambda: handoff.switch(key), switching=True)
    def restore(self):
        h = Handoff(self.home, self.vault, self.desktop)
        self.start(h.recover, switching=True)
    def poll(self):
        try:
            while True:
                kind, value = self.events.get_nowait()
                if kind == 'progress': self.status.set(MESSAGES.get(value, value))
                else:
                    self.busy = False; self.is_switch = False
                    if kind == 'error': self.status.set(MESSAGES.get(value, '작업을 중단했습니다. [' + value + ']'))
                    elif isinstance(value, dict):
                        self.completed = bool(value.get('changed')) or value.get('state') == 'source-restored'
                        self.status.set(MESSAGES['done'] if self.completed else '현재 저장 로그인과 같은 계정입니다.')
                        # A restarted Desktop has a new owner/channel. Do not send
                        # a later quit to the already exited parent process.
                        if self.completed: self.completion_timer = self.ui.after(3500, self.destroy)
                    else: self.status.set(value)
                    self.refresh(); self.controls()
        except queue.Empty: pass
        self.poll_timer = self.ui.after(100, self.poll)
    def destroy(self):
        for timer in (self.poll_timer, self.completion_timer):
            if timer:
                try: self.ui.after_cancel(timer)
                except tk.TclError: pass
        self.ui.destroy()
    def close(self):
        if self.busy:
            if self.is_switch: self.status.set('전환 또는 복구 처리가 끝난 뒤 닫을 수 있습니다.'); return
            self.cancelled.set(); self.status.set('로그인 취소를 확인하고 있습니다.'); return
        self.destroy()
