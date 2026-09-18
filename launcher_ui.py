"""Small Windows installer/launcher progress window; work stays off the UI thread."""
import queue
import threading
import tkinter as tk
from tkinter import ttk


def run(operation):
    window = tk.Tk()
    window.title('Codex Labels')
    window.geometry('520x225')
    window.resizable(False, False)
    window.configure(bg='#202123')
    frame = tk.Frame(window, bg='#202123', padx=24, pady=22)
    frame.pack(fill='both', expand=True)
    tk.Label(frame, text='Codex Labels', font=('맑은 고딕', 16, 'bold'), bg='#202123', fg='#f5f6f7').pack(anchor='w')
    message = tk.StringVar(value='실행 준비 중입니다…')
    tk.Label(frame, textvariable=message, wraplength=470, justify='left', font=('맑은 고딕', 10), bg='#202123', fg='#dbe1e9').pack(anchor='w', pady=(12, 12))
    bar = ttk.Progressbar(frame, maximum=100, mode='determinate'); bar.pack(fill='x')
    actions = tk.Frame(frame, bg='#202123'); actions.pack(fill='x', pady=(12, 0))
    events = queue.Queue()
    state = {'working': True, 'code': 1, 'poll_timer': None}

    def progress(text, percent):
        events.put(('progress', (text, percent)))

    def worker():
        try: events.put(('done', operation(progress)))
        except Exception as error: events.put(('error', str(error)))

    def start():
        for child in actions.winfo_children(): child.destroy()
        state['working'] = True
        bar['value'] = 0
        threading.Thread(target=worker, daemon=False).start()

    def close():
        if state['working']:
            message.set('설치·실행을 진행 중입니다. 완료될 때까지 잠시 기다려 주세요.')
        else: window.destroy()

    def poll():
        while not events.empty():
            kind, value = events.get_nowait()
            if kind == 'progress': message.set(value[0]); bar['value'] = value[1]
            elif kind == 'done':
                if value.get('cancelled'):
                    state['working'] = False
                    window.destroy()
                    return
                state.update(working=False, code=0); bar['value'] = 100
                if value.get('updateError'):
                    message.set('업데이트를 완료하지 못해 이전 버전으로 열었습니다.\n' + value['updateError'])
                    ttk.Button(actions, text='닫기', command=close).pack(side='right')
                else:
                    message.set('계정 선택기를 열고 있습니다…' if value.get('selectorReady') else 'Codex Labels가 열렸습니다.')
                    window.after(50 if value.get('selectorReady') else 1000, window.destroy)
            else:
                state['working'] = False
                message.set('실행하지 못했습니다.\n' + value)
                ttk.Button(actions, text='닫기', command=close).pack(side='right')
                ttk.Button(actions, text='다시 시도', command=start).pack(side='right', padx=8)
        state['poll_timer'] = window.after(100, poll)

    def cancel_poll(event):
        if event.widget is window and state['poll_timer'] is not None:
            try: window.after_cancel(state['poll_timer'])
            except tk.TclError: pass
            state['poll_timer'] = None

    window.protocol('WM_DELETE_WINDOW', close)
    window.bind('<Destroy>', cancel_poll)
    state['poll_timer'] = window.after(100, poll); window.after(50, start)
    window.mainloop()
    return state['code']
