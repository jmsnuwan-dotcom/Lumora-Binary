import json, os, threading, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse

VERSION='LUMORA_V9_LIVE_SIGNAL_FIX'
ROOT=os.path.dirname(os.path.abspath(__file__))
STATE=os.path.join(ROOT,'data.json')
lock=threading.Lock()
clients=[]
history=[]
market={}
active_signal=None
news_target_epoch=0

if os.path.exists(STATE):
    try:
        d=json.load(open(STATE,encoding='utf8'))
        history=d.get('history',[])
        market=d.get('market',{})
        active_signal=d.get('active_signal')
        news_target_epoch=int(d.get('news_target_epoch',0) or 0)
    except Exception:
        pass

def save():
    tmp=STATE+'.tmp'
    with open(tmp,'w',encoding='utf8') as f:
        json.dump({
            'history':history[-300:],
            'market':market,
            'active_signal':active_signal,
            'news_target_epoch':news_target_epoch
        },f,ensure_ascii=False)
    os.replace(tmp,STATE)

def broadcast(obj):
    raw=('data: '+json.dumps(obj,separators=(',',':'),ensure_ascii=False)+'\n\n').encode('utf-8')
    dead=[]
    with lock:
        for w in clients:
            try:
                w.write(raw)
                w.flush()
            except Exception:
                dead.append(w)
        for w in dead:
            if w in clients:
                clients.remove(w)

def clean_active(now=None):
    """Drop an already-expired active signal without creating a fake result.
    The completed result is still accepted later from the EA and history keeps
    the original signal packet.
    """
    global active_signal
    if not active_signal:
        return False
    now=int(now or time.time())
    data=active_signal.get('data',{}) or {}
    try:
        exp=int(data.get('expiry_epoch',0) or 0)
    except Exception:
        exp=0
    if exp <= 0:
        exp=int(active_signal.get('received_at',0) or 0)+int(data.get('expiry_seconds',30) or 30)
    if exp > 0 and now >= exp:
        active_signal=None
        return True
    return False

def build_expiry_result(signal_packet, expiry_price, expired_at=None):
    """Build a deterministic WIN/LOSS result for a completed signal."""
    d=signal_packet.get('data',{}) or {}
    side=str(d.get('side','')).upper()
    entry=float(d.get('entry_price',0) or 0)
    price=float(expiry_price or 0)
    if entry <= 0 or price <= 0 or side not in ('BUY','SELL'):
        return None
    win = (price > entry) if side=='BUY' else (price < entry)
    try:
        stake=float(d.get('stake_usd',2.0) or 2.0)
    except Exception:
        stake=2.0
    try:
        payout=float(d.get('payout_percent',80.0) or 80.0)
    except Exception:
        payout=80.0
    result='WIN' if win else 'LOSS'
    profit=stake*payout/100.0 if win else -stake
    return {
        'signal_id':d.get('signal_id',''),
        'side':side,
        'status':'CLOSED',
        'result':result,
        'entry_price':entry,
        'expiry_price':price,
        'stake_usd':stake,
        'payout_percent':payout,
        'profit_usd':round(profit,2),
        'expired_at':expired_at or time.strftime('%Y.%m.%d %H:%M:%S', time.localtime())
    }

def settle_all_expired(now=None):
    """Reconcile every historical signal that has passed its expiry.
    This prevents a delayed/missing EA result from making older trades vanish
    from Signal History when a newer signal becomes active.
    """
    now=int(now or time.time())
    result_packets=[]
    existing_results=set()
    for old in history:
        if old.get('event')=='signal_result':
            sid=old.get('data',{}).get('signal_id')
            if sid:
                existing_results.add(sid)

    for sig in list(history):
        if sig.get('event')!='signal':
            continue
        d=sig.get('data',{}) or {}
        sid=d.get('signal_id')
        if not sid or sid in existing_results or sig.get('result') in ('WIN','LOSS'):
            continue
        try:
            exp=int(d.get('expiry_epoch',0) or 0)
        except Exception:
            exp=0
        if exp<=0:
            exp=int(sig.get('received_at',0) or 0)+int(d.get('expiry_seconds',30) or 30)
        if exp<=0 or now<exp:
            continue
        side=str(d.get('side','')).upper()
        try:
            bid=float(market.get('bid',0) or 0)
            ask=float(market.get('ask',0) or 0)
        except Exception:
            bid=ask=0.0
        price=bid if side=='BUY' else ask if side=='SELL' else 0.0
        result_data=build_expiry_result(sig,price,
            time.strftime('%Y.%m.%d %H:%M:%S',time.localtime(exp)))
        if not result_data:
            continue
        packet={
            'event':'signal_result',
            'source':sig.get('source','Nyao Scalper v43.0'),
            'symbol':sig.get('symbol','XAUUSD'),
            'timeframe':sig.get('timeframe','M1'),
            'data':result_data,
            'received_at':now,
            'auto_settled':True
        }
        history.append(packet)
        sig['result']=result_data['result']
        sig['result_data']=result_data
        existing_results.add(sid)
        result_packets.append(packet)

    return result_packets

def get_news_target(now=None):
    """Return a persistent countdown target for the dashboard.
    When a real calendar feed is connected later, its event timestamp can
    replace this target without changing the browser countdown logic.
    """
    global news_target_epoch
    now=int(now or time.time())
    if news_target_epoch<=now:
        # Next half-hour boundary; deterministic and refresh-safe.
        news_target_epoch=((now//1800)+1)*1800
    return news_target_epoch

def find_signal(signal_id):
    if not signal_id:
        return None
    for old in reversed(history):
        if old.get('event')=='signal' and old.get('data',{}).get('signal_id')==signal_id:
            return old
    return None

def settle_active_if_expired(now=None):
    """Auto-settle the active signal from the latest MT5 market quote.
    This is a fallback so a missing/delayed EA result cannot make history disappear.
    """
    global active_signal
    if not active_signal:
        return None
    now=int(now or time.time())
    d=active_signal.get('data',{}) or {}
    try:
        exp=int(d.get('expiry_epoch',0) or 0)
    except Exception:
        exp=0
    if exp <= 0:
        exp=int(active_signal.get('received_at',0) or 0)+int(d.get('expiry_seconds',30) or 30)
    if now < exp:
        return None
    side=str(d.get('side','')).upper()
    try:
        bid=float(market.get('bid',0) or 0)
        ask=float(market.get('ask',0) or 0)
    except Exception:
        bid=ask=0.0
    price=bid if side=='BUY' else ask if side=='SELL' else 0.0
    result_data=build_expiry_result(active_signal, price)
    if not result_data:
        return None
    packet={
        'event':'signal_result',
        'source':active_signal.get('source','Nyao Scalper v43.0'),
        'symbol':active_signal.get('symbol','XAUUSD'),
        'timeframe':active_signal.get('timeframe','M1'),
        'data':result_data,
        'received_at':now,
        'auto_settled':True
    }
    history.append(packet)
    old=find_signal(result_data['signal_id'])
    if old is not None:
        old['result']=result_data['result']
        old['result_data']=result_data
    active_signal=None
    return packet

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*a,**kw):
        super().__init__(*a,directory=ROOT,**kw)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin','*')
        self.send_header('Access-Control-Allow-Headers','Content-Type,Authorization')
        self.send_header('Access-Control-Allow-Methods','GET,POST,OPTIONS')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        path=urlparse(self.path).path

        if path=='/api/v1/events':
            self.send_response(200)
            self.send_header('Content-Type','text/event-stream')
            self.send_header('Cache-Control','no-cache, no-store')
            self.send_header('Connection','keep-alive')
            self.end_headers()
            try:
                self.wfile.write(b': connected\n\n')
                self.wfile.flush()
                with lock:
                    clients.append(self.wfile)
                while True:
                    time.sleep(20)
                    try:
                        self.wfile.write(b': ping\n\n')
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                        break
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                pass
            finally:
                with lock:
                    if self.wfile in clients:
                        clients.remove(self.wfile)
            return

        if path=='/api/v1/state':
            with lock:
                now=int(time.time())
                changed=bool(settle_all_expired(now))
                cleaned=clean_active(now)
                news_target=get_news_target(now)
                if changed or cleaned:
                    save()
                payload={
                    'history':history[-300:],
                    'market':market,
                    'active_signal':active_signal,
                    'news':{'target_epoch':news_target,'label':'USD • next scheduled window'},
                    'server_epoch':now,
                    'version':VERSION
                }
            self.send_json(payload)
            return

        if path=='/health':
            self.send_json({'ok':True,'clients':len(clients),'history':len(history),'version':VERSION})
            return

        return super().do_GET()

    def do_POST(self):
        global active_signal, market
        path=urlparse(self.path).path

        if path not in ('/api/v1/signals','/api/v1/market'):
            self.send_json({'error':'not found'},404)
            return

        try:
            n=int(self.headers.get('Content-Length','0'))
            body=json.loads(self.rfile.read(n).decode('utf8'))
            event=body.get('event','signal')
            data=body.get('data',{})

            received_at=int(time.time())
            # The browser and MT5 broker server can have different clock offsets.
            # For the dashboard, the API receipt time is authoritative so a 30-second
            # signal always has exactly 30 seconds remaining after it reaches the site,
            # and a page refresh can never restart the countdown.
            if event=='signal':
                try:
                    expiry_seconds=max(1,int(data.get('expiry_seconds',30) or 30))
                except Exception:
                    expiry_seconds=30
                data=dict(data)
                data['signal_epoch']=received_at
                data['expiry_epoch']=received_at+expiry_seconds
                data['expiry_seconds']=expiry_seconds

            packet={
                'event':event,
                'source':body.get('source','Nyao Scalper v43.0'),
                'symbol':body.get('symbol','XAUUSD'),
                'timeframe':body.get('timeframe','M1'),
                'data':data,
                'received_at':received_at
            }

            auto_result=None
            with lock:
                if event=='market':
                    market=data
                    market['received_at']=received_at
                    # Always expose a live spread derived from the current quote.
                    try:
                        bid=float(market.get('bid',0) or 0)
                        ask=float(market.get('ask',0) or 0)
                        if bid>0 and ask>0:
                            market['spread']=ask-bid
                            # XAUUSD MT5 point-based spread for the dashboard.
                            try:
                                point=float(data.get('point',0) or 0)
                                if point>0:
                                    market['spread_points']=(ask-bid)/point
                            except Exception:
                                pass
                    except Exception:
                        pass
                    # If the EA result packet is late/missing, settle the expired
                    # signal from the latest MT5 quote so completed trades remain
                    # permanently available in Signal History after refresh.
                    auto_results=settle_all_expired(received_at)
                    auto_result=auto_results[-1] if auto_results else None
                    if auto_result:
                        # Keep the market response as the HTTP response, but send
                        # the generated result to connected browsers below.
                        pass
                elif event=='signal':
                    # If the previous signal has already expired, settle it first
                    # before making the new signal authoritative.
                    auto_results=settle_all_expired(received_at)
                    auto_result=auto_results[-1] if auto_results else None
                    active_signal=packet
                    history.append(packet)
                elif event=='signal_result':
                    sid=data.get('signal_id')
                    # Do not store a duplicate result if the server already auto-settled
                    # this signal while the EA result packet was delayed.
                    existing_result=False
                    for old in reversed(history):
                        if old.get('event')=='signal_result' and old.get('data',{}).get('signal_id')==sid:
                            existing_result=True
                            break
                    if not existing_result:
                        history.append(packet)

                    # Mark the exact signal as closed in server state.
                    if active_signal and active_signal.get('data',{}).get('signal_id')==sid:
                        active_signal=None

                    # Attach result to the matching signal packet for easier refresh/rebuild.
                    for old in reversed(history):
                        if old.get('event')=='signal' and old.get('data',{}).get('signal_id')==sid:
                            old['result']=data.get('result')
                            old['result_data']=data
                            break

                save()

            if 'auto_results' in locals():
                for rp in auto_results:
                    broadcast(rp)
            elif auto_result:
                broadcast(auto_result)
            broadcast(packet)
            self.send_json({'ok':True,'event':event})
        except Exception as e:
            self.send_json({'ok':False,'error':str(e)},400)

    def send_json(self,obj,code=200):
        raw=json.dumps(obj,ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


    def finish_request(self, request, client_address):
        # A browser refresh/navigation can abort an HTTP/SSE socket while the
        # request handler is being constructed. Python 3.14 may surface that
        # from finish_request, so swallow only normal client disconnects.
        try:
            return super().finish_request(request, client_address)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError,
                ConnectionRefusedError, TimeoutError):
            return

    def handle_error(self, request, client_address):
        # Do not print scary tracebacks for normal browser/SSE disconnects.
        import sys
        exc=sys.exc_info()[1]
        if isinstance(exc,(BrokenPipeError,ConnectionResetError,ConnectionAbortedError,
                           ConnectionRefusedError,TimeoutError)):
            return
        return super().handle_error(request, client_address)

    def log_message(self,fmt,*args):
        print('[HTTP]',fmt%args)

class ReusableHTTPServer(ThreadingHTTPServer):
    allow_reuse_address=True

if __name__=='__main__':
    port=int(os.environ.get('PORT','8787'))
    print(f'LUMORA {VERSION}: http://localhost:{port}')
    ReusableHTTPServer(('0.0.0.0',port),Handler).serve_forever()

