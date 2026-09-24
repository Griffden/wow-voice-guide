Option Explicit

Dim shell, files, projectPath, electronPath, command
Set files = CreateObject("Scripting.FileSystemObject")
projectPath = files.GetParentFolderName(files.GetParentFolderName(WScript.ScriptFullName))
electronPath = projectPath & "\node_modules\electron\dist\electron.exe"

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = projectPath
command = Chr(34) & electronPath & Chr(34) & " " & Chr(34) & projectPath & Chr(34)
shell.Run command, 1, False
