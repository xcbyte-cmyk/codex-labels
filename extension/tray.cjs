'use strict';

function createTray({app, BrowserWindow, Tray, Menu, nativeImage, iconPath, title, enabled = true}) {
  if (!enabled) return {dispose() {}};
  let tray;
  let quitting = false;
  const managed = new WeakSet();

  function windows() {
    return BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());
  }
  function show() {
    const window = windows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
  function attach(window) {
    if (!tray || managed.has(window)) return;
    managed.add(window);
    window.on('close', event => {
      if (quitting || window.isDestroyed()) return;
      event.preventDefault();
      window.hide();
    });
  }
  function quit() {
    quitting = true;
    app.quit();
  }
  function dispose() {
    quitting = true;
    tray?.destroy();
    tray = undefined;
  }
  app.on('before-quit', () => { quitting = true; });
  app.whenReady().then(async () => {
    try {
      const icon = await app.getFileIcon(iconPath, {size: 'small'});
      if (icon.isEmpty()) return;
      tray = new Tray(icon);
      tray.setToolTip(title);
      tray.setContextMenu(Menu.buildFromTemplate([
        {label: 'Codex Labels 열기', click: show},
        {type: 'separator'},
        {label: '완전히 종료', click: quit},
      ]));
      tray.on('double-click', show);
      for (const window of windows()) attach(window);
    } catch { /* A tray failure must not prevent the app from opening. */ }
  });
  app.on('browser-window-created', (_event, window) => attach(window));
  return {dispose};
}

module.exports = {createTray};
