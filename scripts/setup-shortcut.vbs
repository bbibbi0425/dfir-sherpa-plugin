Option Explicit
Dim shell, fs, action, root, path, link, target, oldRoot
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
action = WScript.Arguments(0)
root = WScript.Arguments(1)
path = shell.SpecialFolders("Desktop") & "\DFIR Sherpa Experiment.lnk"
target = root & "\DFIR-Sherpa-Experiment.cmd"
oldRoot = root
If WScript.Arguments.Count > 2 Then oldRoot = WScript.Arguments(2)
If fs.FileExists(path) Then
  Set link = shell.CreateShortcut(path)
  If LCase(link.TargetPath) <> LCase(target) And LCase(link.TargetPath) <> LCase(oldRoot & "\DFIR-Sherpa-Experiment.cmd") Then
    WScript.Echo "An unrelated Desktop shortcut has this name. Rename it before setup."
    WScript.Quit 1
  End If
End If
If action = "create" Then
  Set link = shell.CreateShortcut(path)
  link.TargetPath = target
  link.WorkingDirectory = root
  link.WindowStyle = 7
  link.Description = "DFIR Sherpa Experiment - automatic local result collection"
  link.Save
ElseIf action = "remove" Then
  If fs.FileExists(path) Then fs.DeleteFile path
ElseIf action <> "check" Then
  WScript.Quit 1
End If
