Option Explicit
Dim shell, fs, root, node, cli, action, app, request, stream, command, result, title, answer
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
title = "DFIR Sherpa Setup"
root = fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName))
node = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.lmstudio\.internal\utils\node.exe"
cli = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.lmstudio\bin\lms.exe"
If Not fs.FileExists(node) Or Not fs.FileExists(cli) Then
  MsgBox "Install LM Studio (tested: 0.4.24), open it once, then retry. Its bundled Node.js and lms CLI are required. No separate npm or administrator account is needed.", 16, title
  WScript.Quit 1
End If
result = shell.Run(Chr(34) & node & Chr(34) & " -e " & Chr(34) & "require('node:sqlite').DatabaseSync" & Chr(34), 0, True)
If result <> 0 Then
  MsgBox "This LM Studio installation lacks the required Node.js SQLite runtime. Update/reinstall LM Studio, then retry setup.", 16, title
  WScript.Quit 1
End If
action = WScript.Arguments(0)
If action = "check" Then
  WScript.Echo "DFIR Sherpa setup: Windows Script Host, bundled Node SQLite and LM Studio CLI found."
  WScript.Quit 0
End If
request = ""
If action = "install" Then
  answer = MsgBox("Keep LM Studio open. Setup installs/updates local/dfir-sherpa and creates a Desktop shortcut. Select the database later in LM Studio. Initial installation needs internet access. Continue?", 33, title)
  If answer <> 1 Then WScript.Quit 0
  app = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\LM Studio\LM Studio.exe"
  If Not fs.FileExists(app) Then app = Trim(InputBox("Paste the full path of LM Studio.exe.", title))
  If Len(app) = 0 Then WScript.Quit 0
  If Left(app, 1) = Chr(34) And Right(app, 1) = Chr(34) Then app = Mid(app, 2, Len(app) - 2)
  If InStr(app, vbCr) Or InStr(app, vbLf) Then WScript.Quit 1
  request = fs.BuildPath(fs.GetSpecialFolder(2), fs.GetTempName)
  Set stream = fs.CreateTextFile(request, False, True)
  stream.WriteLine app
  stream.Close
ElseIf action = "reset" Or action = "uninstall" Then
  answer = MsgBox("Close your analysis first. " & action & " removes the local launcher setting and stops the owned collector. Uninstall also removes the local plugin and Desktop shortcut. Databases, results, models and conversations are preserved. Continue?", 49, title)
  If answer <> 1 Then WScript.Quit 0
Else
  WScript.Quit 1
End If
shell.CurrentDirectory = root
command = Chr(34) & node & Chr(34) & " " & Chr(34) & root & "\scripts\setup.mjs" & Chr(34) & " " & action
If Len(request) > 0 Then command = command & " --request " & Chr(34) & request & Chr(34)
result = shell.Run(command, 0, True)
If Len(request) > 0 Then fs.DeleteFile request
If result = 0 Then
  If action = "install" Then
    MsgBox "Setup complete. Double-click the Desktop shortcut DFIR Sherpa Experiment. In a NEW LM Studio chat, enable local/dfir-sherpa and enter the SQLite path in Canonical timeline DB before your prompt.", 64, title
  Else
    MsgBox action & " complete. Results and databases were preserved. Run setup.cmd to configure again. Restart LM Studio after uninstall.", 64, title
  End If
Else
  MsgBox "Setup did not complete. See outputs\setup-error.json for the error. If a plugin was already installed it may have been updated. Fix the error and retry setup.cmd.", 16, title
End If
WScript.Quit result
