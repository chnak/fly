#!/bin/bash
cd "D:/Date/20260808/fly"
node --experimental-strip-types --no-warnings examples/12-crypto-fly/launch.ts 4399 BTC_USDT 1m 100 10 > test.log 2>&1 &
SVRPID=$!
echo "started pid=$SVRPID"

# T+3s: 第一次检查
sleep 3
echo "=== T+3s ==="
curl -s http://127.0.0.1:4399/api/state | python -c "
import sys, json
d = json.load(sys.stdin)
print(f'phase={d[\"phase\"]}  liveCount={d[\"liveCount\"]}  liveCandlesSinceEval={d[\"liveCandlesSinceEval\"]}/{d[\"liveEvalEveryN\"]}')
print(f'pnl=\${d[\"pnl\"]:.0f}  warmupPnl=\${d[\"warmupPnl\"]:.0f}  gen={d[\"gen\"]}  acc={d[\"accepts\"]}/{d[\"totalTries\"]}')
print(f'last candle ts={d[\"lastNewCandleTs\"]}  trades={len(d[\"trades\"])}')
"

# T+15s: 触发 2-3 次轮询，应该收到新 K 线
sleep 12
echo "=== T+15s ==="
curl -s http://127.0.0.1:4399/api/state | python -c "
import sys, json
d = json.load(sys.stdin)
print(f'phase={d[\"phase\"]}  liveCount={d[\"liveCount\"]}  liveCandlesSinceEval={d[\"liveCandlesSinceEval\"]}/{d[\"liveEvalEveryN\"]}')
print(f'pnl=\${d[\"pnl\"]:.0f}  warmupPnl=\${d[\"warmupPnl\"]:.0f}  gen={d[\"gen\"]}  acc={d[\"accepts\"]}/{d[\"totalTries\"]}')
print(f'last candle ts={d[\"lastNewCandleTs\"]}  trades={len(d[\"trades\"])}')
if d['trades']:
    for t in d['trades'][:5]:
        print(f'  trade: {t[\"action\"]} @ \${t[\"price\"]:.0f} profit=\${t.get(\"profit\", \"-\")}')
"

echo ""
echo "--- server log (last 30 lines) ---"
tail -30 test.log
kill $SVRPID 2>/dev/null
sleep 1
rm test.log