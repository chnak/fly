#!/bin/bash
cd "D:/Date/20260808/fly"
# 100 根 1m K 线 + 10 代预热（快速验证）
node --experimental-strip-types --no-warnings examples/12-crypto-fly/launch.ts 4399 BTC_USDT 1m 100 10 > test.log 2>&1 &
SVRPID=$!
echo "started pid=$SVRPID"
sleep 6
echo "--- server log ---"
cat test.log
echo ""
echo "--- state at T+6s ---"
curl -s http://127.0.0.1:4399/api/state | python -c "
import sys, json
d = json.load(sys.stdin)
print(f'phase={d[\"phase\"]}  candles={d[\"candles\"]}  liveCount={d[\"liveCount\"]}  liveEvalEveryN={d[\"liveEvalEveryN\"]}  nextEvalIn={d[\"liveEvalEveryN\"] - d[\"liveCandlesSinceEval\"]}')
print(f'pnl=\${d[\"pnl\"]:.0f}  warmupPnl=\${d[\"warmupPnl\"]:.0f}  bestPnl=\${d[\"bestPnl\"]:.0f}  pos={d[\"position\"]}')
print(f'raw warmupPnl = {d[\"warmupPnl\"]!r}')
print(f'history={d[\"history\"]}')
print(f'gen={d[\"gen\"]}  acc={d[\"accepts\"]}/{d[\"totalTries\"]}  p={d[\"recentP\"]:.3f} -> {d[\"recentDecision\"]}')
print(f'lastNewCandleTs={d[\"lastNewCandleTs\"]}  trades={len(d[\"trades\"])}')
"
echo ""
echo "--- candles sample ---"
curl -s http://127.0.0.1:4399/api/candles | python -c "
import sys, json
d = json.load(sys.stdin)
cs = d['candles']
print(f'fetched {len(cs)} candles (from idx {d[\"from\"]}), currentIdx={d[\"currentIdx\"]}')
print(f'  first: ts={cs[0][\"ts\"]} close=\${cs[0][\"close\"]:.0f}')
print(f'  last : ts={cs[-1][\"ts\"]} close=\${cs[-1][\"close\"]:.0f}')
"
kill $SVRPID 2>/dev/null
sleep 1
echo "--- done ---"
rm test.log