"""Own one isolated server, run acceptance, restart it and verify recovery.

No existing app server is stopped. Test data is preserved in --out/runtime.
Run this only after implementation freeze.
"""
import argparse, json, os, socket, subprocess, sys, time, urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--port',type=int,default=4399)
    parser.add_argument('--node',default='node')
    args=parser.parse_args()
    out=args.out.resolve();out.mkdir(parents=True,exist_ok=True)
    data=out/'runtime'
    if data.exists():raise SystemExit('Use a new --out path. Existing acceptance data is intentionally preserved.')
    env=os.environ.copy();env.update(PORT=str(args.port),FILINGS_DATA_DIR=str(data))
    url=f'http://127.0.0.1:{args.port}'
    flags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
    def start():
        # Refuse to accidentally target any other agent's already-running service.
        with socket.socket(socket.AF_INET,socket.SOCK_STREAM) as probe:
            probe.bind(('127.0.0.1',args.port))
        process=subprocess.Popen([args.node,'server/index.mjs'],cwd=ROOT,env=env,
                                 stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=flags)
        for _ in range(100):
            if process.poll() is not None:raise RuntimeError('Owned server exited before health became ready.')
            try:
                with urllib.request.urlopen(url+'/api/health',timeout=.5) as response:
                    if response.status==200:
                        runtime=json.loads((data/'runtime.json').read_text(encoding='utf-8'))
                        if runtime['pid']==process.pid:return process
            except Exception:time.sleep(.1)
        process.terminate();process.wait(timeout=10)
        raise RuntimeError('Owned server did not become ready within 10 seconds.')
    def stop(process):
        if process.poll() is None:
            process.terminate()
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
    for phase in ['flow','restart']:
        process=start()
        try:
            run=subprocess.run([sys.executable,str(ROOT/'tests/browser_acceptance.py'),'--url',url,
                                '--out',str(out),'--phase',phase,'--node',args.node],cwd=ROOT,env=env)
            if run.returncode:raise SystemExit(run.returncode)
        finally:stop(process)
    print('Acceptance flow and actual process restart passed. Evidence:',out)

if __name__=='__main__':main()
