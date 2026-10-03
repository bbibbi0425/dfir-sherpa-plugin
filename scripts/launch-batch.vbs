Option Explicit
Dim shell, fs, root, node, action, result
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName))
node = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.lmstudio\.internal\utils\node.exe"
If Not fs.FileExists(node) Then
  MsgBox "LM Studio runtime not found. Run setup.cmd first.", 16, "DFIR Sherpa Batch"
  WScript.Quit 1
End If
action = "--wizard"
If WScript.Arguments.Count > 0 Then
  If WScript.Arguments(0) = "stop" Then action = "--stop"
End If
shell.CurrentDirectory = root
result = shell.Run(Chr(34) & node & Chr(34) & " " & Chr(34) & root & "\scripts\batch.mjs" & Chr(34) & " " & action, 0, True)
If result <> 0 Then
  MsgBox "Batch stopped. Read outputs\batch-error.json for the reason. Existing chats, databases and results were preserved.", 16, "DFIR Sherpa Batch"
Else
  MsgBox "Batch command finished. See outputs\batches\latest.json and outputs\results for status/results.", 64, "DFIR Sherpa Batch"
End If
WScript.Quit result
