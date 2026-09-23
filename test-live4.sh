#!/bin/bash
cd "D:/Date/20260808/fly"
# 1000 根 1m K 线 + 50 代预热 + 每 10 根评估一次
node --experimental-strip-types --no-warnings examples/12-crypto-fly/launch.ts 4399 BTC_USDT 1m 1000 50 10 > test.log 2>&1 &
SVRPID=$!
echo "started pid=$SVRPID at $(date -u +%H:%M:%S) UTC"

# 每 30 秒打一次快照（4 分钟共 8 次）
for i in 1 2 3 4 5 6 7 8; do
  sleep 30
  echo "=== T+${i}*30s at $(date -u +%H:%M:%S) UTC ==="
  curl -s http://127.0.0.1:4399/api/state | python -c "
import sys, json
d = json.load(sys.stdin)
print(f'phase={d[\"phase\"]}  liveCount={d[\"liveCount\"]}  candles={d[\"candles\"]}  liveCandlesSinceEval={d[\"liveCandlesSinceEval\"]}/{d[\"liveEvalEveryN\"]}')
print(f'pnl=\${d[\"pnl\"]:.0f}  warmupPnl=\${d[\"warmupPnl\"]:.0f}  bestPnl=\${d[\"bestPnl\"]:.0f}  gen={d[\"gen\"]}  acc={d[\"accepts\"]}/{d[\"totalTries\"]}')
print(f'last ts={d[\"lastNewCandleTs\"]}  trades={len(d[\"trades\"])}')
if d['trades']:
    for t in d['trades'][-5:]:
        pstr = f\" profit=\${t['profit']:.0f}\" if 'profit' in t else ''
        print(f'  {t[\"action\"]} @ \${t[\"price\"]:.0f}{pstr}')
"
done

echo ""
echo "--- live eval events ---"
grep "live.*eval" test.log
echo ""
echo "--- final state ---"
curl -s http://127.0.0.1:4399/api/state | python -c "
import sys, json
d = json.load(sys.stdin)
print(f'final: gen={d[\"gen\"]}  acc={d[\"accepts\"]}/{d[\"totalTries\"]}  pnl=\${d[\"pnl\"]:.0f}  warmupPnl=\${d[\"warmupPnl\"]:.0f}  liveCount={d[\"liveCount\"]}  trades={len(d[\"trades\"])}')
"

kill $SVRPID 2>/dev/null
sleep 1
rm test.log