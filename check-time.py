#!/usr/bin/env python3
import urllib.request, json, datetime
url = "https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=1m&limit=5"
data = json.loads(urllib.request.urlopen(url).read())
for r in data:
    ts = int(r[0])
    print(f'  ts={ts}  UTC={datetime.datetime.utcfromtimestamp(ts).isoformat()}  close={float(r[2])}')
print(f'--- now UTC = {datetime.datetime.utcnow().isoformat()}')
print(f'--- now+8h Beijing = {datetime.datetime.utcnow() + datetime.timedelta(hours=8)}')