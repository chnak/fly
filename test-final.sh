#!/bin/bash
cd "D:/Date/20260808/fly"
# 默认参数（30 代 warmup + 每 5 根评估）
node --experimental-strip-types --no-warnings examples/12-crypto-fly/launch.ts 4399 BTC_USDT 1m 1000 > test.log 2>&1 &
SVRPID=$!
echo "started pid=$SVRPID at $(date -u +%H:%M:%S) UTC"

for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14; do
  sleep 30
  echo "=== T+${i}*30s at $(date -u +%H:%M:%S) UTC ==="
  STATE=$(curl -s http://127.0.0.1:4399/api/state)
  if [ -z "$STATE" ]; then
    echo "  (no response)"
    continue
  fi
  echo "$STATE" | python -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(f'  phase={d[\"phase\"]}  liveCount={d[\"liveCount\"]}  candles={d[\"candles\"]}  liveCandlesSinceEval={d[\"liveCandlesSinceEval\"]}/{d[\"liveEvalEveryN\"]}')
    print(f'  pnl=\${d[\"pnl\"]:.0f}  warmupPnl=\${d[\"warmupPnl\"]:.0f}  gen={d[\"gen\"]}  acc={d[\"accepts\"]}/{d[\"totalTries\"]}  pos={d[\"position\"]}  trades={len(d[\"trades\"])}')
    if d['trades']:
        for t in d['trades'][-5:]:
            pstr = f\" profit=\${t['profit']:.0f}\" if 'profit' in t else ''
            print(f'    {t[\"action\"]} @ \${t[\"price\"]:.0f}{pstr}')
except Exception as e:
    print(f'  ERR: {e}')
"
done

echo ""
echo "--- live eval events ---"
grep -i "eval gen" test.log

echo ""
echo "--- final ---"
curl -s http://127.0.0.1:4399/api/state 2>/dev/null | python -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(f'final: liveCount={d[\"liveCount\"]}  gen={d[\"gen\"]}  acc={d[\"accepts\"]}/{d[\"totalTries\"]}  pnl=\${d[\"pnl\"]:.0f}  trades={len(d[\"trades\"])}')
except: pass
" 2>/dev/null

kill $SVRPID 2>/dev/null
sleep 1
rm test.log