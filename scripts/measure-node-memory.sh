#!/bin/bash
# ravend(regtest) · kubo(임시 저장소) 메모리 측정 — 합성 자료만. docs/memory-budget.md 3절.
#   scripts/measure-node-memory.sh <ravend·raven-cli 가 든 폴더> [kubo 초(기본 90)]
# 🔴 대표의 ~/.raven·~/.ipfs·실행 중인 노드를 건드리지 않는다: datadir/IPFS_PATH 는 mktemp,
#    포트는 비표준(regtest 29xxx, kubo 25001/28080/24001), connect=0·listen=0.
# macOS 는 RSS 가 메모리 압축으로 크게 흔들려 `footprint`(phys_footprint)를 함께 적는다.
set -u
BIN=${1:?ravend 폴더}; SECS=${2:-90}
OUTDIR=$(cd "$(dirname "$0")/.." && pwd)/artifacts/memory-budget; mkdir -p "$OUTDIR"
echo "[" > $OUTDIR/ravend-regtest.json; first=1
fp() { footprint $1 2>/dev/null | python3 -c 'import re,sys;m=re.search(r"Footprint: ([0-9.]+) (\w+)",sys.stdin.read());v=float(m.group(1)) if m else 0;u=m.group(2) if m else "MB";print(int(v/1024 if u=="KB" else v*1024 if u=="GB" else v))'; }
rss() { echo $(( $(ps -o rss= -p $1) / 1024 )); }
run() {
  name=$1; shift
  D=$(mktemp -d "${TMPDIR:-/tmp}/rvmem-node-XXXX"); P=$((29000 + RANDOM % 900)); R=$((P+1000))
  printf "regtest=1\nserver=1\nlisten=0\nconnect=0\ndnsseed=0\nrpcuser=memtest\nrpcpassword=memtest-synthetic\n[regtest]\nport=$P\nrpcport=$R\nrpcbind=127.0.0.1\nrpcallowip=127.0.0.1\n" > $D/raven.conf
  for a in "$@"; do echo "$a" >> $D/raven.conf; done
  $BIN/ravend -datadir=$D -daemon=0 >/dev/null 2>&1 & pid=$!
  cli="$BIN/raven-cli -datadir=$D"
  for i in $(seq 60); do $cli getblockcount >/dev/null 2>&1 && break; sleep 1; done
  sleep 3; idle=$(rss $pid); idlef=$(fp $pid)
  addr=$($cli getnewaddress)
  $cli generatetoaddress 400 $addr >/dev/null
  sleep 2; mined=$(rss $pid); minedf=$(fp $pid)
  for i in $(seq 150); do $cli sendtoaddress $($cli getnewaddress) 0.5 >/dev/null 2>&1; done
  mp=$($cli getmempoolinfo | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["size"], d["usage"])')
  sleep 2; mem=$(rss $pid); memf=$(fp $pid)
  threads=$(ps -M -p $pid | tail -n +2 | wc -l | tr -d ' ')
  $cli stop >/dev/null; wait $pid; rm -rf $D
  [ $first = 1 ] || echo "," >> $OUTDIR/ravend-regtest.json; first=0
  echo "{\"config\":\"$name\",\"args\":\"$*\",\"rss_idle_mb\":$idle,\"rss_after_400_blocks_mb\":$mined,\"rss_with_mempool_mb\":$mem,\"footprint_idle_mb\":$idlef,\"footprint_after_400_blocks_mb\":$minedf,\"footprint_with_mempool_mb\":$memf,\"mempool\":\"$mp\",\"threads\":$threads}" >> $OUTDIR/ravend-regtest.json
  echo "$name rss idle/mined/mempool=$idle/$mined/$mem MB footprint=$idlef/$minedf/$memf MB ($mp) threads=$threads"
}
run core-default "assetindex=1" "addressindex=1"
run template-normal "assetindex=1" "addressindex=1" "dbcache=450" "maxconnections=40"
run template-lowspec "assetindex=1" "addressindex=1" "dbcache=300" "maxmempool=100" "maxconnections=16"
run proposed-lowmem "assetindex=1" "addressindex=1" "dbcache=100" "maxmempool=50" "maxconnections=12" "par=1" "rpcthreads=2" "maxsigcachesize=8" "maxorphantx=20"
run boost-4096 "assetindex=1" "addressindex=1" "dbcache=4096"
echo "]" >> $OUTDIR/ravend-regtest.json

[ "${RV_SKIP_KUBO:-0}" = 1 ] && exit 0
command -v ipfs >/dev/null || { echo "kubo(ipfs) 없음 — 측정 불가"; exit 0; }
echo "[" > $OUTDIR/kubo.json; first=1
run() {
  name=$1; profile=$2; offline=$3; shift 3
  export IPFS_PATH=$(mktemp -d "${TMPDIR:-/tmp}/rvmem-ipfs-XXXX")
  ipfs init --profile=$profile >/dev/null 2>&1 || { echo "init failed $name"; return; }
  ipfs config Addresses.API /ip4/127.0.0.1/tcp/25001 >/dev/null
  ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/28080 >/dev/null
  ipfs config --json Addresses.Swarm '["/ip4/0.0.0.0/tcp/24001","/ip4/0.0.0.0/udp/24001/quic-v1"]' >/dev/null
  for kv in "$@"; do k=${kv%%=*}; v=${kv#*=}; ipfs config --json "$k" "$v" >/dev/null || echo "config fail $k"; done
  extra=""; [ "$offline" = 1 ] && extra="--offline"
  ipfs daemon $extra >/dev/null 2>&1 & pid=$!
  for i in $(seq 30); do ipfs --api /ip4/127.0.0.1/tcp/25001 id >/dev/null 2>&1 && break; sleep 1; done
  sleep 5; early=$(fp $pid)
  peak=$early; for i in $(seq $((SECS/10))); do sleep 10; v=$(fp $pid); [ $v -gt $peak ] && peak=$v; done
  final=$(fp $pid); peers=$(ipfs --api /ip4/127.0.0.1/tcp/25001 swarm peers 2>/dev/null | wc -l | tr -d ' ')
  rss=$(( $(ps -o rss= -p $pid) / 1024 )); threads=$(ps -M -p $pid | tail -n +2 | wc -l | tr -d ' ')
  ipfs --api /ip4/127.0.0.1/tcp/25001 shutdown >/dev/null 2>&1; wait $pid; rm -rf $IPFS_PATH
  [ $first = 1 ] || echo "," >> $OUTDIR/kubo.json; first=0
  echo "{\"config\":\"$name\",\"profile\":\"$profile\",\"offline\":$offline,\"overrides\":\"$*\",\"seconds\":$SECS,\"footprint_5s_mb\":$early,\"footprint_peak_mb\":$peak,\"footprint_final_mb\":$final,\"rss_final_mb\":$rss,\"peers\":$peers,\"threads\":$threads}" >> $OUTDIR/kubo.json
  echo "$name 5s=${early}MB peak=${peak}MB final=${final}MB rss=${rss}MB peers=$peers threads=$threads"
}
run offline-lowpower lowpower 1
run online-default-networking default-networking 0
run online-lowpower lowpower 0
run online-lowpower-conn20 lowpower 0 'Swarm.ConnMgr.HighWater=20' 'Swarm.ConnMgr.LowWater=10' 'Swarm.ResourceMgr.MaxMemory="128MB"'
run online-lowpower-dhtclient-conn20 lowpower 0 'Routing.Type="dhtclient"' 'Swarm.ConnMgr.HighWater=20' 'Swarm.ConnMgr.LowWater=10' 'Swarm.ResourceMgr.MaxMemory="128MB"'
echo "]" >> $OUTDIR/kubo.json
