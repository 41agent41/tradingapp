#!/bin/sh
# Writes the gateway's allow list from GATEWAY_ALLOW (comma separated, IBKR's
# wildcard form such as 10.0.0.*) and starts the gateway. Only addresses on
# the list may use the API or open the login page, so list the app server and
# the machine you sign in from, nothing wider.
set -eu
CONF=root/conf.yaml
ALLOW="${GATEWAY_ALLOW:-127.0.0.1}"
{
  echo "ips:"
  echo "  allow:"
  echo "    - 127.0.0.1"
  echo "$ALLOW" | tr ',' '\n' | sed '/^ *$/d; s/^ */    - /'
  echo "  deny: []"
} > /tmp/ips.yaml
# Replace the shipped ips: block (it ends where the next top-level key starts).
awk 'BEGIN{skip=0} /^ips:/{skip=1; while ((getline line < "/tmp/ips.yaml") > 0) print line; next}
     skip && /^[^ ]/{skip=0} !skip{print}' "$CONF" > /tmp/conf.yaml
cp /tmp/conf.yaml "$CONF"
exec sh bin/run.sh "$CONF"
