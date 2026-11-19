# Setup on Windows 11

The server and the agents run under your normal Windows account. The agents have the same rights you have in a terminal: your files, `git`, keys, your Claude Code, Codex and Antigravity logins.

Paste each block of commands **one line at a time**: when several lines are pasted at once, PowerShell can run them out of order.

## 1. Node.js and dependencies

You need Node.js 22 or newer (`node -v`).

PowerShell may block scripts, and then `npm` reports "running scripts is disabled". In that case type `npm.cmd` instead of `npm`: there is no need to change the policy.

```powershell
cd C:\Users\<you>\Documents\GitHub\remote-control
npm.cmd ci
npm.cmd run build
copy config.example.json config.json
copy agents.example.json agents.json
copy .env.example .env
```

## 2. Configuration

`config.json`:

- `allowedRoots`: folders the agents may work in, for example `C:\Users\<you>\Documents\GitHub`. When starting an agent in the UI you can pick the folder itself or any of its first-level subfolders.
- `origin`: the address for the phone, `https://<name>.<tailnet>.ts.net`. Until Tailscale is set up, remove this field: then only the UI on the computer works.

`agents.json`: absolute paths to the agents. To find a path: `(Get-Command claude).Source`, `(Get-Command codex).Source`, `(Get-Command agy).Source`. For agents installed with npm, use the `.cmd` file, not the `.ps1`. The `cwd` field sets the default folder; it must be inside `allowedRoots`.

Flags that turn off approvals (`--dangerously-skip-permissions`, `--yolo`, `--full-auto`, `-a never` and the like) are refused by the server. The server cannot see the approval mode set in the agent's own settings (`~/.claude/settings.json`, `~/.codex/config.toml`): do not turn on auto-approval there.

## 3. First start

```powershell
npm.cmd start
```

Open `http://localhost:8780` in the browser on the computer. There is no login: this address is reachable only from the computer itself, and you can start agents right away.

Stopping and restarting an agent at the computer is confirmed with a second press of the button. Only the phone needs a passkey.

## 4. Remote access from the phone

Remote access is off by default. It is a separate port, `127.0.0.1:8781`, which `tailscale serve` publishes inside the tailnet. Turning it on or off does not affect running agents.

1. Install Tailscale on the computer and the phone, and sign in to the same tailnet.
2. In the Tailscale admin console, turn on MagicDNS and HTTPS Certificates.
3. Publish **port 8781** (not 8780) inside the tailnet only:

   ```powershell
   tailscale serve --bg 8781
   tailscale serve status          # https://<name>.<tailnet>.ts.net -> http://127.0.0.1:8781
   tailscale funnel status         # must be empty
   ```

4. Put the address into `origin` in `config.json` and restart the server.
5. In the UI on the computer, turn on Remote access.
6. Open Phone and press "Get a code". On the phone, open `https://<name>.<tailnet>.ts.net`, choose "Connect this device with a code", enter the code and create a passkey with biometrics. From then on the phone signs in with this passkey.

**Never use `tailscale funnel`.** Funnel exposes the service to the internet. If it was on: `tailscale funnel reset`.

Recommended:

- set `tailscaleUser` in `config.json` (your Tailscale login), so the server lets in only your tailnet account;
- restrict Tailscale ACLs so only your devices can connect to this computer;
- turn on `ntfy` notifications (phone sign-in, remote access turned on, an agent waiting for approval).

Remote access can be turned off with the button in the header (at the computer or from the phone) or with `npm.cmd run remote -- off`. To see its state: `npm.cmd run remote -- status`. Turning it off ends all remote sessions at once.

There is no need to configure Windows Firewall: both ports listen on `127.0.0.1` only. Do not create rules that open 8780 or 8781.

## 5. Start at Windows sign-in

Stop `npm start` (Ctrl+C). In a normal PowerShell (not as administrator):

```powershell
$dir = "$env:USERPROFILE\Documents\GitHub\remote-control"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -WorkingDirectory $dir -Argument "-NoProfile -WindowStyle Hidden -Command `"cmd.exe /c 'node --env-file-if-exists=.env server\index.js >> data\server.log 2>&1'`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName "RemoteControl" -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited
Start-ScheduledTask -TaskName "RemoteControl"
```

No password is needed: the task runs in your session after you sign in. To check: `curl.exe -s http://127.0.0.1:8780/api/state` returns JSON. Make a shortcut or a bookmark for `http://localhost:8780`; Chrome and Edge can install it as an app (menu, "Install").

To stop the server: `Stop-ScheduledTask RemoteControl`. Agents end when the server stops.

## 6. Testing the kill switch

1. Start any agent.
2. In PowerShell: `npm.cmd run killswitch`. Expected: "Agents killed: <id>", "Web sessions revoked: N", "Remote access: off".
3. Within 10 seconds the browser goes back to the login screen, and the agent shows as "exited" in the list.
4. Repeat with the "Kill all" button (two presses).

The kill switch always turns remote access off too.

## Maintenance

- Changed `config.json` or `agents.json`: restart the server (`Stop-ScheduledTask RemoteControl`, then `Start-ScheduledTask RemoteControl`).
- Lost the phone: at the computer, delete its passkey on the Phone page and turn off remote access. To delete all phone passkeys and sessions at once: `npm.cmd run reset-auth`.
- Audit log: the `audit` table in `data\remote-control.db`, for example `sqlite3 data\remote-control.db "select datetime(ts/1000,'unixepoch'), event, ip, detail from audit order by id desc limit 50"`.
