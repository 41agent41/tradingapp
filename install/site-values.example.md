# Site values

The values this install was built with, as defined in the values sheet at the
top of [docs/INSTALL.md](../docs/INSTALL.md#values-sheet). Copy this file to
`/opt/tradingapp/site-values.md` and fill in the **Value** column (INSTALL
step 2.5). Write `not built` for a server you did not build.

**No secrets here.** No passwords, tokens, keys or bridge secrets. INSTALL
lists where each secret lives.

| Placeholder | Meaning | Value |
|---|---|---|
| `gateway` | The LAN's gateway | FILL-IN |
| `lan-range` | The LAN, in CIDR form | FILL-IN |
| `admin-address` | The computer the app is managed from | FILL-IN |
| `db-address` | CT 100, the database | FILL-IN |
| `app-address` | CT 110, the app | FILL-IN |
| `mt5-address` | VM 120, the MetaTrader 5 bridge | FILL-IN |
| `ib-address` | CT 130, IB Gateway and the Client Portal Gateway | FILL-IN |
| `proxy-address` | CT 140, the reverse proxy | FILL-IN |
| `prometheus-address` | CT 150, Prometheus | FILL-IN |
| `grafana-address` | CT 160, Grafana | FILL-IN |
| `domain` | The name the app is reached by through the proxy | FILL-IN |
| `mt5-user` | The login user on VM 120 | FILL-IN |
| `mt5-server-tz` | The MT5 broker's server time zone | FILL-IN |
| `mt5-fingerprint` | The sidecar certificate's SHA-256 fingerprint | FILL-IN |
| `paper-account-id` | The IBKR paper account id | FILL-IN |

## Decisions

The answers to "Decisions to make first" in INSTALL.

| Question | Answer |
|---|---|
| 1. Trying it out, or building to keep | FILL-IN |
| 2. Firms connected, and the step used for each | FILL-IN |
| 3. Interactive Brokers: Web API or IB Gateway | FILL-IN |
| 4. MetaTrader 5: Ubuntu with Wine, or Windows | FILL-IN |
| 5. Reverse proxy and TLS (step 7) | FILL-IN |
| 6. Monitoring (step 9) | FILL-IN |

## Changes from the fixed values

Guest IDs, hostnames and ports are the same on every install. List here any
you changed, and why. Write `none` if you changed nothing.

FILL-IN
