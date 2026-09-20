Option Explicit
Dim shell, fs, root, node, command, result
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName))
node = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.lmstudio\.internal\utils\node.exe"
If Not fs.FileExists(node) Then
  MsgBox "LM Studio bundled Node.js was not found. Install LM Studio first.", 16, "DFIR Sherpa Experiment"
  WScript.Quit 1
End If
shell.CurrentDirectory = root
command = Chr(34) & node & Chr(34) & " " & Chr(34) & root & "\scripts\desktop_launcher.mjs" & Chr(34)
result = shell.Run(command, 0, True)
If result = 0 Then
  MsgBox "Ready. Create a NEW LM Studio chat with DFIR Sherpa enabled, set Canonical timeline DB to your SQLite path, then enter your prompt. Results are saved automatically. No stop command is needed.", 64, "DFIR Sherpa Experiment"
Else
  MsgBox "Collector could not become ready. Do not begin analysis. See outputs\launcher-error.json and outputs\results\.collector logs.", 16, "DFIR Sherpa Experiment"
End If
WScript.Quit result
