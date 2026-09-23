'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {createTray} = require('./tray.cjs');

test('close hides the window; tray restores it; quit remains explicit', async () => {
  const app = new EventEmitter();
  app.whenReady = () => Promise.resolve();
  app.getFileIcon = async () => ({isEmpty: () => false});
  app.quit = () => { app.emit('before-quit'); app.quitted = true; };
  const window = new EventEmitter();
  window.isDestroyed = () => false;
  window.isMinimized = () => false;
  window.hide = () => { window.hidden = true; };
  window.show = () => { window.hidden = false; };
  window.focus = () => { window.focused = true; };
  const BrowserWindow = {getAllWindows: () => [window]};
  let menu, icon;
  class Tray extends EventEmitter {
    constructor(value) { super(); icon = value; this.destroy = () => {}; }
    setToolTip() {}
    setContextMenu(value) { menu = value; }
  }
  const Menu = {buildFromTemplate: value => value};
  createTray({app, BrowserWindow, Tray, Menu, iconPath: 'app.exe', title: 'Codex Labels'});
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(icon);
  const closeEvent = {preventDefault() { this.prevented = true; }};
  window.emit('close', closeEvent);
  assert.equal(closeEvent.prevented, true);
  assert.equal(window.hidden, true);
  menu[0].click();
  assert.equal(window.hidden, false);
  menu[2].click();
  assert.equal(app.quitted, true);
  const finalClose = {preventDefault() { this.prevented = true; }};
  window.emit('close', finalClose);
  assert.equal(finalClose.prevented, undefined);
});
