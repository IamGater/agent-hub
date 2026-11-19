' Agent Hub launcher: starts the server hidden if it is not running yet, then opens the installed app.
' Usage: wscript scripts\launch.vbs [chrome-app-id]
Option Explicit

Const URL = "http://127.0.0.1:8780/"
Const TIMEOUT_SEC = 30

Dim sh, fso, root, appId, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

appId = ""
If WScript.Arguments.Count > 0 Then appId = WScript.Arguments(0)

Function ServerUp()
  Dim http
  ServerUp = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 1000, 1000
  http.Open "GET", URL, False
  http.Send
  If Err.Number = 0 Then ServerUp = (http.Status > 0)
  On Error GoTo 0
End Function

If Not ServerUp() Then
  sh.CurrentDirectory = root
  ' Window style 0 = hidden; False = do not wait. Output goes to server.log (ignored by git).
  ' --max-semi-space-size=1: a smaller young generation; the server allocates little, ~15 MB saved.
  sh.Run "cmd /c node --max-semi-space-size=1 --env-file-if-exists=.env server\index.js >> server.log 2>&1", 0, False
  For i = 1 To TIMEOUT_SEC * 2
    WScript.Sleep 500
    If ServerUp() Then Exit For
  Next
  If Not ServerUp() Then
    MsgBox "Agent Hub server did not start within " & TIMEOUT_SEC & " s." & vbCrLf & _
      "See " & root & "\server.log", vbExclamation, "Agent Hub"
    WScript.Quit 1
  End If
End If

If appId <> "" Then
  sh.Run """C:\Program Files\Google\Chrome\Application\chrome_proxy.exe"" --profile-directory=Default --app-id=" & appId, 1, False
Else
  sh.Run "http://localhost:8780/", 1, False
End If
