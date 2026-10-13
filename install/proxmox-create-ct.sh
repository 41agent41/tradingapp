#!/usr/bin/env bash
# Create the TradingApp app container on a Proxmox VE host.
#
# Run on the Proxmox host as root. Creates an unprivileged Ubuntu 24.04 LXC
# with the features Docker-in-LXC needs (nesting, keyctl, and fuse on ZFS
# storage), starts it, and waits for its network. Idempotent: an existing
# container with that id is checked, not recreated.
#
# This is PROXMOX_DEPLOYMENT.md §4.1 (or Appendix A with --bundled-db) as a
# script; read that section for why each flag is there.
#
#   proxmox-create-ct.sh --ctid 110 --ip 10.7.3.20/24 --gw 10.7.3.1 [options]
#
# Options:
#   --storage NAME      container storage (default local-lvm)
#   --bridge NAME       network bridge (default vmbr0)
#   --hostname NAME     (default tradingapp)
#   --nameserver IP     (default: the gateway)
#   --ssh-key FILE      public key to authorise for root in the container
#   --cores N --memory MB --disk GB
#                       defaults 4 / 8192 / 60, or 6 / 12288 / 200 with
#                       --bundled-db (the database lives in this container)
#   --bundled-db        size for the single-container layout (Appendix A)
#
# Exit codes: 0 done, 1 a step failed, 2 bad arguments.

set -Eeuo pipefail
trap 'printf "[pve] ERROR: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2; exit 1' ERR

log() { printf '[pve] %s\n' "$*"; }
fail() {
    local code=$1
    shift
    printf '[pve] ERROR: %s\n' "$*" >&2
    exit "$code"
}

CTID='' IP='' GW='' STORAGE=local-lvm BRIDGE=vmbr0 HOSTNAME_=tradingapp NS='' SSH_KEY=''
CORES='' MEMORY='' DISK='' BUNDLED=0

while (($#)); do
    case $1 in
        --ctid) CTID=$2 && shift 2 ;;
        --ip) IP=$2 && shift 2 ;;
        --gw) GW=$2 && shift 2 ;;
        --storage) STORAGE=$2 && shift 2 ;;
        --bridge) BRIDGE=$2 && shift 2 ;;
        --hostname) HOSTNAME_=$2 && shift 2 ;;
        --nameserver) NS=$2 && shift 2 ;;
        --ssh-key) SSH_KEY=$2 && shift 2 ;;
        --cores) CORES=$2 && shift 2 ;;
        --memory) MEMORY=$2 && shift 2 ;;
        --disk) DISK=$2 && shift 2 ;;
        --bundled-db) BUNDLED=1 && shift ;;
        -h | --help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//' && exit 0 ;;
        *) fail 2 "unknown argument $1" ;;
    esac
done

[[ $EUID -eq 0 ]] || fail 2 "run as root on the Proxmox host"
for c in pct pvesm pveam; do command -v "$c" >/dev/null || fail 1 "$c not found: this is not a Proxmox VE host"; done
[[ $CTID =~ ^[0-9]+$ ]] || fail 2 "--ctid is required (a number)"
[[ $IP =~ ^[0-9.]+/[0-9]+$ ]] || fail 2 "--ip is required, in CIDR form (10.7.3.20/24)"
[[ $GW =~ ^[0-9.]+$ ]] || fail 2 "--gw is required"
[[ ${IP%%/*} != 172.20.* ]] || fail 2 "$IP overlaps the stack's Docker network 172.20.0.0/16"
NS=${NS:-$GW}
if ((BUNDLED)); then
    CORES=${CORES:-6} MEMORY=${MEMORY:-12288} DISK=${DISK:-200}
else
    CORES=${CORES:-4} MEMORY=${MEMORY:-8192} DISK=${DISK:-60}
fi

features=nesting=1,keyctl=1
stype=$(pvesm status --storage "$STORAGE" 2>/dev/null | awk 'NR==2 {print $2}')
[[ -n $stype ]] || fail 1 "storage $STORAGE not found (pvesm status)"
[[ $stype == zfspool ]] && features=$features,fuse=1
log "storage $STORAGE is $stype; features $features"

if pct status "$CTID" >/dev/null 2>&1; then
    log "container $CTID exists; checking it"
    conf=$(pct config "$CTID")
    grep -q '^unprivileged: 1' <<<"$conf" || fail 1 "container $CTID is privileged; PROXMOX_DEPLOYMENT.md §1.2 says keep it unprivileged"
    for f in nesting=1 keyctl=1; do
        grep -E '^features:' <<<"$conf" | grep -q "$f" || fail 1 "container $CTID lacks $f: pct set $CTID --features $features, then restart it"
    done
    if [[ $stype == zfspool ]] && ! grep -E '^features:' <<<"$conf" | grep -q fuse=1; then
        fail 1 "container $CTID is on ZFS without fuse=1: pct set $CTID --features $features, then restart it"
    fi
else
    log "fetching the Ubuntu 24.04 template"
    pveam update >/dev/null
    tmpl=$(pveam available --section system | awk '$2 ~ /^ubuntu-24\.04-standard_.*_amd64\.tar\.zst$/ {print $2}' | sort -V | tail -n1)
    [[ -n $tmpl ]] || fail 1 "no ubuntu-24.04-standard template offered by pveam"
    pveam list local | grep -q "$tmpl" || pveam download local "$tmpl"

    args=(
        --hostname "$HOSTNAME_"
        --cores "$CORES" --memory "$MEMORY" --swap 1024
        --rootfs "$STORAGE:$DISK"
        --net0 "name=eth0,bridge=$BRIDGE,firewall=1,ip=$IP,gw=$GW"
        --nameserver "$NS"
        --features "$features"
        --unprivileged 1
        --onboot 1 --startup "order=2,up=30"
    )
    [[ -n $SSH_KEY ]] && args+=(--ssh-public-keys "$SSH_KEY")
    log "creating container $CTID ($CORES cores, ${MEMORY} MB, ${DISK} GB)"
    pct create "$CTID" "local:vztmpl/$tmpl" "${args[@]}"
fi

if [[ $(pct status "$CTID") != *running* ]]; then
    pct start "$CTID"
fi

log "waiting for the container's network"
for _ in $(seq 1 30); do
    if pct exec "$CTID" -- getent hosts github.com >/dev/null 2>&1; then
        log "container $CTID is up at ${IP%%/*} and resolves names"
        log "next: pct push $CTID install.sh /root/install.sh; pct push $CTID <answers> /etc/tradingapp/install.answers (AGENT_INSTALL_RUNBOOK.md phase 2)"
        exit 0
    fi
    sleep 2
done
fail 1 "container $CTID started but cannot resolve github.com; check --gw/--nameserver and the bridge"
