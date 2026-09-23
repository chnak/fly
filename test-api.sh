#!/bin/bash
cd "D:/Date/20260808/fly"
node --experimental-strip-types --no-warnings examples/12-crypto-fly/launch.ts 4399 BTC_USDT 1m 100 10 > test.log 2>&1 &
SVRPID=$!
echo "started pid=$SVRPID"
sleep 6
echo "--- raw /api/state ---"
curl -s -w '\nHTTP %{http_code} size=%{size_download}\n' http://127.0.0.1:4399/api/state | head -5
echo ""
echo "--- raw /api/state (no pipe) ---"
curl -s http://127.0.0.1:4399/api/state > /tmp/state.json 2>&1
wc -c /tmp/state.json
echo "--- state.json head 200 ---"
head -c 500 /tmp/state.json
echo ""
echo "--- check for Infinity ---"
grep -c "Infinity" /tmp/state.json || echo "no Infinity"
kill $SVRPID 2>/dev/null
sleep 1
rm test.log