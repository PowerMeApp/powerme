import subprocess, json, os, sys, random
L=sys.argv[1]; N=int(sys.argv[2]); seedbase=int(sys.argv[3]); res=[]
rnd=random.Random(seedbase)
for i in range(N):
    th=rnd.choice([100,300]); seed=rnd.randint(1,9999); sh=rnd.randint(0,9999)
    env=dict(os.environ,COUNT_ONLY="1",NP="BRANDES_KOEPF",SHUF=str(sh))
    r=subprocess.run(["python3","erd_elk.py",L,"RIGHT",str(seed),str(th)],capture_output=True,text=True,env=env)
    try: j=json.loads(r.stdout.strip().splitlines()[-1])
    except Exception: continue
    res.append((j["cross"], round(j["w"]*j["h"]/1e6,1),th,seed,sh)); res.sort(); print(i, res[0], flush=True)
res.sort(); print(L, res[:4], flush=True)
