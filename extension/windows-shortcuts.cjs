'use strict';
// Owl does not implement Electron's shell shortcut APIs. Use Windows' Unicode
// shell interfaces only for the fixed Labels shortcut; paths stay data, not code.
const {execFileSync} = require('node:child_process');
const SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
$request=$env:CODEX_LABELS_SHORTCUT_REQUEST | ConvertFrom-Json
if ($request.operation -eq 'read') {
  if (-not (Test-Path -LiteralPath $request.path)) { throw 'Shortcut does not exist' }
  $w=New-Object -ComObject WScript.Shell
  $link=$w.CreateShortcut($request.path)
  $folder=(New-Object -ComObject Shell.Application).NameSpace((Split-Path -Parent $request.path))
  $item=$folder.ParseName((Split-Path -Leaf $request.path))
  @{target=$link.TargetPath; args=$link.Arguments; appUserModelId=$item.ExtendedProperty('System.AppUserModel.ID')} | ConvertTo-Json -Compress
  exit
}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
[ComImport, Guid("00021401-0000-0000-C000-000000000046")] class LabelsLink { }
[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ILabelsLink {
 void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p,int c,IntPtr d,uint f);
 void GetIDList(out IntPtr p); void SetIDList(IntPtr p);
 void GetDescription([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder p,int c);
 void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string p);
 void GetWorkingDirectory([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder p,int c);
 void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string p);
 void GetArguments([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder p,int c);
 void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string p);
 void GetHotkey(out short p); void SetHotkey(short p); void GetShowCmd(out int p); void SetShowCmd(int p);
 void GetIconLocation([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder p,int c,out int i);
 void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string p,int i);
 void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string p,uint r); void Resolve(IntPtr w,uint f);
 void SetPath([MarshalAs(UnmanagedType.LPWStr)] string p);
}
[StructLayout(LayoutKind.Sequential)] struct Key { public Guid fmt; public uint id; public Key(uint i){fmt=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");id=i;} }
[StructLayout(LayoutKind.Explicit, Size=24)] struct Value { [FieldOffset(0)] public ushort type; [FieldOffset(8)] public IntPtr data; }
[ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ILabelsProperties { void GetCount(out uint c); void GetAt(uint i,out Key k); void GetValue(ref Key k,out Value v); void SetValue(ref Key k,ref Value v); void Commit(); }
public static class LabelsShortcut {
 [DllImport("shell32.dll")] static extern void SHChangeNotify(uint change,uint flags,IntPtr item1,IntPtr item2);
 public static void Write(string file,string target,string args,string cwd,string appId,string clsid) {
  object obj=new LabelsLink();
  try {
   var link=(ILabelsLink)obj; link.SetPath(target); link.SetArguments(args); link.SetWorkingDirectory(cwd);
   link.SetDescription("Codex Labels"); link.SetIconLocation(target,0); link.SetShowCmd(1);
   var props=(ILabelsProperties)obj; var idKey=new Key(5); var clsKey=new Key(26);
   var id=new Value {type=31,data=Marshal.StringToCoTaskMemUni(appId)};
   var cls=new Value {type=72,data=Marshal.AllocCoTaskMem(16)};
   try { Marshal.StructureToPtr(new Guid(clsid),cls.data,false); props.SetValue(ref idKey,ref id); props.SetValue(ref clsKey,ref cls); props.Commit(); }
   finally {Marshal.FreeCoTaskMem(id.data);Marshal.FreeCoTaskMem(cls.data);}
   ((IPersistFile)obj).Save(file,true);
   SHChangeNotify(0x08000000,0,IntPtr.Zero,IntPtr.Zero);
  } finally {Marshal.FinalReleaseComObject(obj);}
 }
}
'@
$d=$request.details
[LabelsShortcut]::Write($request.path,$d.target,$d.args,$d.cwd,$d.appUserModelId,$d.toastActivatorClsid)
'true'
`;
function createShortcutAdapter(shell, {run = execFileSync, env = process.env} = {}) {
  function call(value) {
    return JSON.parse(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(SCRIPT, 'utf16le').toString('base64')], {
      env: {...env, CODEX_LABELS_SHORTCUT_REQUEST: JSON.stringify(value)},
      encoding: 'utf8', windowsHide: true, timeout: 15000
    }).trim());
  }
  return {
    read: typeof shell.readShortcutLink === 'function' ? file => shell.readShortcutLink(file)
      : file => call({operation: 'read', path: file}),
    write: typeof shell.writeShortcutLink === 'function' ? (file, operation, details) => shell.writeShortcutLink(file, operation, details)
      : (file, operation, details) => call({operation, path: file, details})
  };
}
module.exports = {createShortcutAdapter};
