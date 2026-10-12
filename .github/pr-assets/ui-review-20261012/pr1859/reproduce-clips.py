#!/usr/bin/env python3
"""Reproduce full-frame, real-time trims from the untouched source recordings."""
from pathlib import Path
import sys,hashlib,json,subprocess,tempfile
root=Path(__file__).resolve().parent
specs=[{'side':'before','source':'before/video/page@34fe129622ad8c3fea3656dd7c26897d.webm','sourceSha256':'f0c7a7cf79899e114322adcd988aa0250f43f953b9013963ab4d446d5434ddd2','start':'113.5','duration':'5.5','frames':['0.5','2.5','4.5']},{'side':'after','source':'after/video/page@f68e32c1c0682ebe0e20da2843d185cb.webm','sourceSha256':'b2dfa62ae0baecf08a916668639b603e3208b4f049dcdf05be4538891a82a03e','start':'73.5','duration':'4.5','frames':['0.5','2.5','3.5']}]
verify='--verify' in sys.argv
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def command(args):
 p=subprocess.run(args,cwd=root,capture_output=True,text=True,timeout=60)
 if p.returncode:raise RuntimeError(json.dumps({'argv':args,'exit':p.returncode,'stderr':p.stderr}))
 return p.stdout
def probe(p):
 return json.loads(command(['ffprobe','-v','error','-count_frames','-show_entries','format=duration:stream=codec_name,width,height,avg_frame_rate,r_frame_rate,start_time,nb_read_frames','-of','json',str(p)]))
def generate(out):
 (out/'clips').mkdir(parents=True,exist_ok=True);(out/'frames').mkdir(exist_ok=True);rows=[]
 for s in specs:
  source=root/s['source'];assert sha(source)==s['sourceSha256'],s['source'];dest=out/'clips'/(s['side']+'.webm')
  args=['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-y','-ss',s['start'],'-i',str(source),'-t',s['duration'],'-map','0:v:0','-an','-c:v','libvpx-vp9','-crf','28','-b:v','0','-threads','1','-row-mt','0','-fflags','+bitexact','-flags:v','+bitexact','-map_metadata','-1',str(dest)]
  command(args);frames=[]
  for i,t in enumerate(s['frames']):
   frame=out/'frames'/f"{s['side']}-{i+1}.png";fa=['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-y','-ss',t,'-i',str(dest),'-frames:v','1','-threads','1','-fflags','+bitexact','-flags:v','+bitexact',str(frame)];command(fa)
   frames.append({'path':str(frame.relative_to(out)),'clipSecond':t,'sha256':sha(frame),'bytes':frame.stat().st_size,'argv':fa})
  rows.append({**s,'path':str(dest.relative_to(out)),'sha256':sha(dest),'bytes':dest.stat().st_size,'argv':args,'measured':probe(dest),'frames':frames})
 return rows
if verify:
 expected=json.loads((root/'clips.json').read_text())
 assert sorted(p.name for p in (root/'clips').iterdir())==['after.webm','before.webm']
 assert sorted(p.name for p in (root/'frames').iterdir())==[f'{side}-{i}.png' for side in ['after','before'] for i in range(1,4)]
 with tempfile.TemporaryDirectory(prefix='pr1859-trim-verify-') as t:
  result=generate(Path(t))
  for actual,prior in zip(result,expected['clips']):
   assert actual['sha256']==prior['sha256'] and actual['measured']==prior['measured'],actual['side']
   assert sha(root/prior['path'])==prior['sha256']
   for a,p in zip(actual['frames'],prior['frames']):assert a['sha256']==p['sha256']==sha(root/p['path'])
 print(json.dumps({'verified':True,'clips':2,'frames':6,'exactRegisteredInventory':True,'allOutputsByteIdentical':True}))
else:
 result=generate(root)
 (root/'clips.json').write_text(json.dumps({'interpretation':'Requested seek/duration are editor inputs; measured stream times/frame counts describe the encoded files. Full frame, original speed, no overlays or inserted frames. The continuous clips include transitions between the three distinct controlled fixture cases; they are not a single live Devin session.','encoderVersion':command(['ffmpeg','-version']).splitlines()[0],'clips':result},indent=2)+'\n')
 print(json.dumps({'generated':True,'clips':[{k:r[k] for k in ['side','path','sha256','measured']} for r in result]}))
