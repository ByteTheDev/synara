import json,sys,statistics as st
D=sys.argv[1]
def load(kind):
    return [json.load(open(f"{D}/{kind}-{i}.json")) for i in (1,2,3)], [json.load(open(f"{D}/{kind}-{i}.summary.json")) for i in (1,2,3)]
B,BS=load('base'); C,CS=load('cand')
def med(v):
    v=[x for x in v if x is not None]; return st.median(v) if v else None
def stepval(runs,step,key):
    out=[]
    for r in runs:
        for s in r['steps']:
            if s['step']!=step: continue
            if key in ('frameP50','frameP95','dropped'):
                g=sorted(s['gaps'])
                out.append(g[len(g)//2] if key=='frameP50' else g[int(len(g)*.95)] if key=='frameP95' else sum(1 for x in g if x>8.34*1.5)/len(g)*100)
            else: out.append(s.get(key))
    return med(out)
def sv(sums,step,key): return med([s.get(step,{}).get(key) for s in sums])
pct=lambda a,b: '' if not a else f"{(b-a)/a*100:+.0f}%"
print("startupMs", med([r['startupMs'] for r in B]), "→", med([r['startupMs'] for r in C]))
print(f"{'step':13} {'visible ms':>16} {'':>6} {'click INP':>10} {'main busy':>11} {'scripting':>10} {'rendering':>10} {'painting':>9} {'max task':>9}")
for step in ['cold:mega','cold:handoff','cold:long','cold:hero','cold:small','warm:mega','warm:handoff','warm:long','warm:hero']:
    b=stepval(B,step,'bottomMs'); c=stepval(C,step,'bottomMs')
    print(f"{step:13} {b:7.0f} → {c:5.0f} {pct(b,c):>6} {stepval(B,step,'clickInteractionMs'):4.0f} → {stepval(C,step,'clickInteractionMs'):3.0f} {sv(BS,step,'busy'):4.0f} → {sv(CS,step,'busy'):4.0f} {sv(BS,step,'scripting'):4.0f} → {sv(CS,step,'scripting'):3.0f} {sv(BS,step,'rendering'):4.0f} → {sv(CS,step,'rendering'):3.0f} {sv(BS,step,'painting'):3.0f} → {sv(CS,step,'painting'):3.0f} {sv(BS,step,'maxTask'):4.0f} → {sv(CS,step,'maxTask'):3.0f}")
print()
for step in ['scroll:mega','scroll:long','scroll:hero']:
    print(f"{step:12} fps-frame p50 {stepval(B,step,'frameP50'):.1f}→{stepval(C,step,'frameP50'):.1f} p95 {stepval(B,step,'frameP95'):.1f}→{stepval(C,step,'frameP95'):.1f} dropped% {stepval(B,step,'dropped'):.1f}→{stepval(C,step,'dropped'):.1f} LoAF {stepval(B,step,'longAnimationFrames')}→{stepval(C,step,'longAnimationFrames')} jumpPx {stepval(B,step,'jumpPx')}→{stepval(C,step,'jumpPx')} busy {sv(BS,step,'busy')}→{sv(CS,step,'busy')} render {sv(BS,step,'rendering')}→{sv(CS,step,'rendering')} script {sv(BS,step,'scripting')}→{sv(CS,step,'scripting')} paint {sv(BS,step,'painting')}→{sv(CS,step,'painting')} docRecalcs {sv(BS,step,'styleRecalcs500')}→{sv(CS,step,'styleRecalcs500')} maxTask {sv(BS,step,'maxTask')}→{sv(CS,step,'maxTask')}")
