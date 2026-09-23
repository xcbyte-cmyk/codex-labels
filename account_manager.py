"""Small local account-window picker; login remains in the official Codex UI."""
import queue
import threading
import tkinter as tk
from tkinter import ttk, messagebox
import account_profiles


def run(root, launch, delete, *, launch_default=None, close_on_launch=False,
        switch_account=None, switch_default=None, describe_account=None):
    window = tk.Tk()
    window.title('Codex Labels · 실행환경 및 계정')
    window.geometry('760x520'); window.minsize(740, 480)
    frame = ttk.Frame(window, padding=24); frame.pack(fill='both', expand=True)
    ttk.Label(frame, text='실행환경 및 연결 계정', font=('맑은 고딕', 18, 'bold')).pack(anchor='w')
    ttk.Label(frame, text='실행환경마다 대화·설정·라벨을 따로 보관합니다.\n계정 전환은 선택한 환경의 기록을 유지한 채 로그인만 바꿉니다.',
              justify='left').pack(anchor='w', pady=(10, 16))
    tree = ttk.Treeview(frame, columns=('name', 'account'), show='headings', height=7, selectmode='browse')
    tree.heading('name', text='실행환경'); tree.column('name', width=200)
    tree.heading('account', text='연결된 저장 로그인'); tree.column('account', width=280); tree.pack(fill='both', expand=True)
    status = tk.StringVar(value='환경을 선택해 열거나, 그 환경에서 사용할 계정을 전환하세요.')
    ttk.Label(frame, textvariable=status, wraplength=520).pack(anchor='w', pady=(12, 8))
    row = ttk.Frame(frame); row.pack(fill='x')
    name = ttk.Entry(row); name.pack(side='left', fill='x', expand=True)
    events = queue.Queue(); busy = False; poll_timer = None
    buttons = []

    def refresh(selected=None):
        tree.delete(*tree.get_children())
        for item in account_profiles.list_accounts(root):
            account = describe_account(item['id']) if describe_account else ''
            tree.insert('', 'end', iid=item['id'], values=(item['name'] + (' · 삭제 미완료' if item.get('deleting') else ''), account))
        if selected: tree.selection_set(selected)

    def add():
        if busy: return
        try:
            item = account_profiles.create(root, name.get()); refresh(item['id']); name.delete(0, 'end')
            status.set('실행환경을 추가했습니다. 환경을 열거나 연결할 계정을 선택하세요.')
        except Exception as error: messagebox.showerror('계정 창 추가', str(error), parent=window)

    def start_launch(operation):
        nonlocal busy
        if busy: return
        busy = True; set_buttons(True); status.set('선택한 계정 창을 열고 있습니다…')
        def worker():
            try:
                result = operation(progress=lambda text, _: events.put(('progress', text)))
                events.put(('done', result))
            except Exception as error: events.put(('error', str(error)))
        threading.Thread(target=worker, daemon=False).start()

    def open_selected(_event=None):
        selected = tree.selection()
        if selected:
            key = selected[0]
            start_launch(lambda **kw: launch(root, key, **kw))

    def delete_selected():
        nonlocal busy
        selected = tree.selection()
        if busy or not selected: return
        account_id = selected[0]
        item = next((item for item in account_profiles.list_accounts(root) if item['id'] == account_id), None)
        if not item: refresh(); return
        if not messagebox.askyesno('계정 창과 로컬 자료 삭제',
            f'“{item["name"]}” 계정 창을 삭제할까요?\n\n'
            '이 창과 실행 중인 작업을 종료하고 로그인 정보·대화·설정·라벨·캐시를 영구 삭제합니다.\n'
            '백업이나 휴지통 사본을 남기지 않으며 복구할 수 없습니다.\n\n'
            '다른 계정 창, 외부 작업 폴더, ChatGPT 계정·구독 자체는 삭제하지 않습니다.',
            parent=window, icon='warning', default='no'):
            return
        busy = True; set_buttons(True); status.set('선택한 계정 창을 삭제하고 있습니다…')
        def worker():
            try:
                result = delete(root, account_id, progress=lambda text, _: events.put(('progress', text)))
                events.put(('deleted', result))
            except Exception as error: events.put(('error', str(error)))
        threading.Thread(target=worker, daemon=False).start()

    add_button = ttk.Button(row, text='새 실행환경 추가', command=add)
    add_button.pack(side='left', padx=(8, 0))
    actions = ttk.Frame(frame); actions.pack(fill='x', pady=(14, 0))
    delete_button = ttk.Button(actions, text='실행환경 삭제', command=delete_selected)
    delete_button.pack(side='left')
    open_button = ttk.Button(actions, text='환경 열기', command=open_selected)
    open_button.pack(side='right')
    buttons.extend((add_button, delete_button, open_button))
    if switch_account:
        def switch_selected():
            selected = tree.selection()
            if selected:
                start_launch(lambda **kw: switch_account(root, selected[0], **kw))
        switch_button = ttk.Button(actions, text='연결 계정 전환', command=switch_selected)
        switch_button.pack(side='right', padx=8); buttons.append(switch_button)
    if launch_default:
        default_button = ttk.Button(actions, text='기본 프로필 열기',
                                    command=lambda: start_launch(launch_default))
        default_button.pack(side='right', padx=8)
        buttons.append(default_button)
    if switch_default:
        default_switch = ttk.Button(frame, text='기본 환경 계정 전환', command=lambda: start_launch(switch_default))
        default_switch.pack(anchor='e', pady=(8, 0)); buttons.append(default_switch)
    def set_buttons(disabled):
        for button in buttons:
            button.state(['disabled'] if disabled else ['!disabled'])
        name.state(['disabled'] if disabled else ['!disabled'])
    tree.bind('<Double-1>', open_selected)
    def poll():
        nonlocal busy, poll_timer
        while not events.empty():
            kind, value = events.get_nowait()
            if kind == 'progress': status.set(value)
            else:
                busy = False; set_buttons(False)
                if kind == 'done' and close_on_launch:
                    window.destroy()
                    return
                if kind in ('deleted', 'error'):
                    try: refresh()
                    except Exception as error: status.set(str(error)); continue
                status.set('계정 창이 열렸습니다. 다른 계정도 선택해 열 수 있습니다.' if kind == 'done' else
                           '계정 창과 로컬 자료를 삭제했습니다. 남은 계정 폴더가 없는지 확인했습니다.' if kind == 'deleted' else value)
        poll_timer = window.after(100, poll)
    def cancel_poll(event):
        if event.widget is window and poll_timer is not None:
            try: window.after_cancel(poll_timer)
            except tk.TclError: pass
    window.bind('<Destroy>', cancel_poll)
    window.protocol('WM_DELETE_WINDOW', lambda: status.set('실행 준비가 끝난 뒤 닫아 주세요.') if busy else window.destroy())
    refresh(); poll_timer = window.after(100, poll); window.mainloop()
    return 0
