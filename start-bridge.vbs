' start-bridge.vbs - launch the bundled Responses bridge (127.0.0.1:7864) with no window.
'
' Why this exists:
'   node.exe is a console-subsystem program, so Windows allocates a conhost window
'   first and the screen flashes black. wscript.exe is a GUI-subsystem program with
'   no console of its own; it starts node as a child with window style 0 (hidden),
'   so nothing flashes.
'
' Usage: drop it in the Startup folder, or call it from a scheduled task
'        wscript.exe //B "<dir>\start-bridge.vbs"
'
' No api_key to configure: bin/serve.mjs reads it from the gateway's config.json.
'
' ASCII only on purpose - VBScript files are read as ANSI by wscript.exe, so a
' UTF-8 comment here would be mojibake at best and a parse error at worst.

Option Explicit

Dim fso, sh, dir, exe, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

dir = fso.GetParentFolderName(WScript.ScriptFullName)

exe = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(exe) Then exe = "node.exe"

cmd = """" & exe & """ """ & dir & "\bin\serve.mjs"" --port 7864"

' 0 = hidden window; False = do not wait for the child
sh.Run cmd, 0, False