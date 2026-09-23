#!/bin/bash
cd "D:/Date/20260808/fly"
node --experimental-strip-types --no-warnings examples/12-crypto-fly/launch.ts 4399 BTC_USDT 1m 100 10 > test.log 2>&1 &
SVRPID=$!
echo "started pid=$SVRPID at $(date -u +%H:%M:%S) UTC"

# 每 15 秒打一次快照
for i in 1 2 3 4 5 6; do
  sleep 15
  echo "=== T+${i}*15s at $(date -u +%H:%M:%S) UTC ==="
  curl -s http://127.0.0.1:4399/api/state | python -c "
import sys, json
d = json.load(sys.stdin)
print(f'phase={d[\"phase\"]}  liveCount={d[\"liveCount\"]}  candles={d[\"candles\"]}  liveCandlesSinceEval={d[\"liveCandlesSinceEval\"]}')
print(f'pnl=\${d[\"pnl\"]:.0f}  warmupPnl=\${d[\"warmupPnl\"]:.0f}  gen={d[\"gen\"]}  acc={d[\"accepts\"]}/{d[\"totalTries\"]}')
print(f'last candle ts={d[\"lastNewCandleTs\"]}  trades={len(d[\"trades\"])}')
if d['trades']:
    for t in d['trades'][:3]:
        print(f'  trade: {t[\"action\"]} @ \${t[\"price\"]:.0f}')
"
done

echo ""
echo "--- server log (last 40 lines) ---"
tail -40 test.log
kill $SVRPID 2>/dev/null
sleep 1
rm test.log