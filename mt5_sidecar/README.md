# MT5 sidecar

A small HTTP service that sits next to a MetaTrader 5 terminal and lets the
broker service trade through it. The `MetaTrader5` Python package only runs on
Windows Python and talks to a terminal on the same machine. So the app's
broker service (on Linux) calls this sidecar over HTTP, and the sidecar calls
the terminal.

The HTTP contract is documented at the top of `broker_service/mt5_adapter.py`.
`broker_service/tests/test_mt5_sidecar_contract.py` runs that adapter against
this code on every CI run.

One sidecar serves one terminal logged in to one account. For two accounts,
run two terminals and two sidecars on two ports.

## What it guarantees

- **Shared secret.** Every request, `/health` included, must carry
  `X-MT5-Bridge-Secret`. The sidecar will not start on a non-loopback address
  without a secret of at least 24 characters.
- **Stop attached at entry.** A market order is a single `order_send` with
  `sl`/`tp` filled in, never an entry followed by a modify. The response
  echoes the stop the terminal recorded on the position, read back after the
  fill, so a stop the broker dropped shows as `null` and the app treats the
  entry as unprotected.
- **Stops are never cleared.** `POST /positions/{symbol}/stop` keeps the
  take-profit when `tp` is absent or null, and keeps the stop when `sl` is
  null.
- **Symbols match case-insensitively.** `EURUSDM` finds `EURUSDm`; an exact
  match wins if both exist.
- **Volumes are not rounded.** A quantity off the symbol's lot step is refused.
- **Paper and live cannot cross.** A `paper` order to a real-money account, or
  a `live` order to a demo account, is refused. Real-money orders also need
  `MT5_ALLOW_REAL=true` here, on top of the app's `LIVE_TRADING_ENABLED`.
- **Hedging accounts close, not hedge.** On a hedging account, an order
  against an open position closes tickets oldest first instead of opening an
  opposite ticket. An order that would reverse through flat is refused.
  `/positions` reports one net row per symbol, with a stop of 0 if any ticket
  on that side has none.
- **Times are UTC.** MT5 reports times on the trade server's clock. The
  sidecar converts them with `MT5_SERVER_TZ`, and converts history ranges the
  other way.
- **The terminal comes back.** With `MT5_TERMINAL_PATH` set, every request
  checks the terminal and relaunches it if it has gone. `/health` answers 503
  while it is offline. Requotes are retried twice at a fresh price.

## Settings

Copy `sidecar.env.example` to `sidecar.env` next to `server.py`. Variables in
the process environment take precedence over the file.

| Variable | Default | Meaning |
|---|---|---|
| `MT5_BRIDGE_SECRET` | none | Shared secret; the same value the app's connection uses |
| `MT5_SIDECAR_HOST` / `_PORT` | `127.0.0.1` / `9100` | Listen address |
| `MT5_TERMINAL_PATH` | none | `terminal64.exe` to attach to, and launch if it is not running |
| `MT5_PORTABLE` | `false` | Start the terminal in portable mode (one install folder per account) |
| `MT5_LOGIN` / `_PASSWORD` / `_SERVER` | none | Log in on start; with `MT5_LOGIN` set, a terminal logged in to another account is refused |
| `MT5_SERVER_TZ` | `UTC` | The trade server's time zone, such as `Europe/Athens` |
| `MT5_MAGIC` | `61000` | Magic number on every order this sidecar sends |
| `MT5_DEVIATION_POINTS` | `20` | Slippage accepted on market orders |
| `MT5_ALLOW_REAL` | `false` | Allow orders on a real-money account |

In the terminal: turn **Algo Trading** on (`/health` reports
`trading_disabled` while it is off), and raise **Tools → Options → Charts →
Max bars in chart** if you need long histories.

## Windows

1. Install the MT5 terminal from your broker. For two accounts, install twice
   into two folders, say `C:\MT5-A` and `C:\MT5-B`, and use `MT5_PORTABLE=true`.
2. Install 64-bit Python 3.11 from python.org.
3. Install the sidecar:

   ```powershell
   cd C:\tradingapp\mt5_sidecar
   python -m pip install -r requirements.txt
   copy sidecar.env.example sidecar.env   # then edit it
   python server.py                        # try it in the foreground first
   ```

4. Run it at logon. The terminal needs an interactive desktop, so use Task
   Scheduler with automatic logon, not a Windows service:

   ```powershell
   $action  = New-ScheduledTaskAction -Execute "powershell.exe" `
     -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\tradingapp\mt5_sidecar\deploy\run-sidecar.ps1"
   $trigger = New-ScheduledTaskTrigger -AtLogOn
   $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
     -ExecutionTimeLimit ([TimeSpan]::Zero)
   Register-ScheduledTask -TaskName "MT5 sidecar A" -Action $action -Trigger $trigger -Settings $settings
   ```

   `run-sidecar.ps1` restarts the sidecar if it exits and logs to
   `sidecar.log`. For a second account, copy the folder, give it its own
   `sidecar.env` (another port and terminal path), and register a second task.

5. Allow the port through Windows Firewall, from the app host only.

## Linux with Wine

The terminal and Windows Python both run under Wine, headless on Xvfb. This
fits in a Proxmox VM or a privileged LXC container next to the app.

```bash
sudo apt install wine64 xvfb winbind
sudo useradd -m -d /var/lib/mt5 mt5
sudo -u mt5 -i
export WINEPREFIX=/var/lib/mt5/broker-a WINEDEBUG=-all

# Windows Python into the prefix, then the terminal.
wget https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe
xvfb-run wine python-3.11.9-amd64.exe /quiet InstallAllUsers=0 PrependPath=1
wget https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe
xvfb-run wine mt5setup.exe /auto     # or your broker's installer

wine python -m pip install -r /opt/tradingapp/mt5_sidecar/requirements.txt
```

Log in once by hand so the terminal saves the account (for example over VNC
with `x11vnc` on the Xvfb display), and turn Algo Trading on. Then put the
settings in `/etc/mt5-sidecar/broker-a.env` with
`MT5_TERMINAL_PATH=C:\Program Files\MetaTrader 5\terminal64.exe`, and start
the unit:

```bash
sudo cp /opt/tradingapp/mt5_sidecar/deploy/mt5-sidecar@.service /etc/systemd/system/
sudo systemctl enable --now mt5-sidecar@broker-a
journalctl -u mt5-sidecar@broker-a -f
```

Each account gets its own prefix (`/var/lib/mt5/<name>`), env file and port.

## Checking it

From the app host, so the network path is tested too:

```bash
H="X-MT5-Bridge-Secret: $SECRET"
curl -H "$H" http://SIDECAR:9100/health           # status ok, account_type demo
curl http://SIDECAR:9100/health                   # 401
curl -H "$H" "http://SIDECAR:9100/symbol?symbol=EURUSD"
curl -H "$H" "http://SIDECAR:9100/quote?symbol=EURUSD"
date -u +%s                                       # compare with the quote's time
```

The quote's `time` should be within a few seconds of `date -u +%s` while the
market is open. If it is off by whole hours, `MT5_SERVER_TZ` is wrong. Then
follow steps 5 to 9 of `PAPER_DEPLOYMENT_RUNBOOK.md`.

## Development

Tests use `tests/fake_mt5.py`, an in-memory stand-in for the `MetaTrader5`
package, so they run on any OS:

```bash
pip install -r requirements.txt -r requirements-dev.txt   # MetaTrader5 is skipped off Windows
ruff check . && black --check . && pytest -q
```
