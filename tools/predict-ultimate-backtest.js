#!/usr/bin/env node
/* Backtest the app's ultimate cooling-done prediction against the Pack log.
   Loads PREDICT_ULTIMATE (+ helpers) from app/index.html (PREDICT_ULTIMATE-BEGIN … END).
   Also loads PREDICT/predictOff so next-off can floor the ultimate estimate when the fan is on.
   Usage: node tools/predict-ultimate-backtest.js [--from 2026-10-16] [--to 2026-10-25] [--csv file.csv] [--set key=value ...] [--json]
   Default source: Pack log public CSV. Times in the box's local zone (Perth). */
"use strict";
const fs=require("fs"),path=require("path"),vm=require("vm");
const SHEET="10Xp3xuxtlholYFS-oJ5VRpQiAplPkU5YD3JqET3iA_A";
const URL="https://docs.google.com/spreadsheets/d/"+SHEET+"/export?format=csv";
const args=process.argv.slice(2),opt={set:[]};
for(let i=0;i<args.length;i++){const a=args[i];if(a==="--json")opt.json=true;else if(a==="--set")opt.set.push(args[++i]);else if(a.startsWith("--"))opt[a.slice(2)]=args[++i]}

const html=fs.readFileSync(path.join(__dirname,"..","app","index.html"),"utf8");
const m1=/\/\*PREDICT-BEGIN[\s\S]*?\/\*PREDICT-END\*\//.exec(html);
const m2=/\/\*PREDICT_ULTIMATE-BEGIN[\s\S]*?\/\*PREDICT_ULTIMATE-END\*\//.exec(html);
if(!m1){console.error("PREDICT block not found");process.exit(1)}
if(!m2){console.error("PREDICT_ULTIMATE block not found");process.exit(1)}
const ctx={};vm.createContext(ctx);
vm.runInContext(m1[0]+";this.PREDICT=PREDICT;this.predictOff=predictOff;this.predPm=predPm;",ctx);
vm.runInContext(m2[0]+";this.PREDICT_ULTIMATE=PREDICT_ULTIMATE;this.predictUltimate=predictUltimate;this.parkSessionBounds=parkSessionBounds;this.fanStretches=fanStretches;this.predUltPm=predUltPm;",ctx);
const PU=ctx.PREDICT_ULTIMATE,P=ctx.PREDICT;
for(const kv of opt.set){const [k,v]=kv.split("=");PU[k]=isNaN(+v)?v:+v}

function parseCSV(t){const rows=[];let row=[],f="",q=false;t=t.replace(/^\uFEFF/,"");
 for(let i=0;i<t.length;i++){const c=t[i];
  if(q){if(c==='"'){if(t[i+1]==='"'){f+='"';i++}else q=false}else f+=c}
  else if(c==='"')q=true;else if(c===","){row.push(f);f=""}else if(c==="\n"||c==="\r"){if(c==="\r"&&t[i+1]==="\n")i++;row.push(f);rows.push(row);row=[];f=""}else f+=c}
 if(f||row.length){row.push(f);rows.push(row)}return rows}
const num=v=>{v=(v||"").trim();if(v==="")return null;const x=+v;return isFinite(x)?x:null};
const hm=t=>new Date(t).toLocaleTimeString("en-AU",{hour:"numeric",minute:"2-digit"}).replace(/\s/g," ").toLowerCase();
const dstr=t=>new Date(t).toLocaleDateString("en-CA");
const pct=(a,p)=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.ceil(p*s.length)-1)]};
const f1=x=>x===null?"--":(x>=0?"+":"")+x.toFixed(1);

(async()=>{
 const text=opt.csv?fs.readFileSync(opt.csv,"utf8"):await (await fetch(URL)).text();
 const R=parseCSV(text),h=R[0].map(x=>x.trim().toLowerCase()),ix=k=>h.indexOf(k);
 let rows=R.slice(1).map(c=>({u:num(c[ix("unix")]),pack:num(c[ix("pack_c")]),amb:num(c[ix("ambient_c")]),fan:num(c[ix("fan_on")]),off:num(c[ix("off_c")]),mode:(c[ix("mode")]||"").trim().toLowerCase()}))
  .filter(r=>r.u&&r.mode!=="mode").map(r=>({t:r.u*1000,pack:r.pack,amb:r.amb,fan:r.fan===null?null:(r.fan>=1?1:0),off:r.off,mode:r.mode})).sort((a,b)=>a.t-b.t);
 let carry="";rows.forEach(r=>{if(r.mode)carry=r.mode;else if(carry)r.mode=carry});
 const from=opt.from?new Date(opt.from+"T00:00:00").getTime():-Infinity,to=opt.to?new Date(opt.to+"T23:59:59").getTime():Infinity;

 /* parked cool sessions: between driving/cap boundaries, with at least one cool mode */
 function sessions(){const out=[];let cur=null;
  for(let i=0;i<rows.length;i++){const m=rows[i].mode;
   if(m==="driving"){if(cur){cur.end=i-1;cur.endWhy="driving";out.push(cur);cur=null}continue}
   if(m==="cap"){if(cur){cur.end=i-1;cur.endWhy="cap";out.push(cur);cur=null}continue}
   if(!cur)cur={start:i,end:i,endWhy:"open"};cur.end=i}
  if(cur)out.push(cur);
  return out.filter(s=>rows.slice(s.start,s.end+1).some(r=>PU.coolModes.indexOf(r.mode)>=0))}

 function ultimateOf(slice){const offs=[];
  for(let j=1;j<slice.length;j++)if(slice[j-1].fan===1&&slice[j].fan===0&&slice[j].t-slice[j-1].t<=PU.gapMin*60e3)
   offs.push({t:(slice[j-1].t+slice[j].t)/2,prev:slice[j-1].mode,mode:slice[j].mode});
  for(let k=offs.length-1;k>=0;k--)if(slice.every(r=>r.t<=offs[k].t||r.fan!==1))return{...offs[k],n:offs.length};
  return null}

 const segs=sessions().filter(s=>rows[s.start].t>=from&&rows[s.start].t<=to);
 const complete=[],allPts=[];
 const durs=[],cycs=[],onLens=[],idleGaps=[];

 for(const s of segs){
  const slice=rows.slice(s.start,s.end+1);
  const ult=ultimateOf(slice);
  const St=ctx.fanStretches(rows,s.start,s.end,PU);
  St.forEach(st=>onLens.push((st.t1-st.t0)/60e3+2.5));
  for(let k=1;k<St.length;k++)idleGaps.push((St[k].t0-St[k-1].t1)/60e3);
  if(!ult){complete.push({start:rows[s.start].t,ultimate:null,endWhy:s.endWhy||"open",cycles:St.length,n:0,skip:"no-off"});continue}
  /* Ground truth filter: ultimate must hold — idle after last off until cap/drive, not cut mid-cycle by a drive */
  const after=slice.filter(r=>r.t>ult.t);
  const idleAfterMin=after.filter(r=>PU.idleModes.indexOf(r.mode)>=0).length*5;
  const held=(s.endWhy==="cap"&&idleAfterMin>=5)||(idleAfterMin>=PU.settleIdleMin);
  const cutByDrive=s.endWhy==="driving"&&idleAfterMin<PU.settleIdleMin;
  if(!held||cutByDrive){complete.push({start:rows[s.start].t,ultimate:null,endWhy:s.endWhy||"open",cycles:St.length,n:0,skip:cutByDrive?"drive-cut":"thin-idle"});continue}
  durs.push((ult.t-rows[s.start].t)/60e3);cycs.push(ult.n);
  const pts=[];
  for(let i=s.start;i<=s.end;i++){
   if(rows[i].t>=ult.t)break;
   if(rows[i].t-rows[s.start].t<15*60e3)continue;
   const prefix=rows.slice(0,i+1);
   let nextOff=null;try{nextOff=ctx.predictOff(prefix,P)}catch(e){}
   const p=ctx.predictUltimate(prefix,PU,{now:rows[i].t,nextOff:nextOff&&nextOff.state==="ok"?nextOff:null});
   if(p.state==="ok"){const e=(p.t-ult.t)/60e3;pts.push({at:rows[i].t,lead:p.lead,e,ae:Math.abs(e),pm:p.pm,cyclesDone:p.cyclesDone,settled:!!p.settled})}
  }
  pts.forEach(p=>allPts.push({...p,si:complete.length}));
  complete.push({start:rows[s.start].t,ultimate:ult.t,endWhy:s.endWhy||"open",cycles:ult.n,durMin:(ult.t-rows[s.start].t)/60e3,
   modes:[...new Set(slice.map(r=>r.mode).filter(Boolean))],n:pts.length,
   med:pct(pts.map(p=>p.ae),.5),p90:pct(pts.map(p=>p.ae),.9),first:pts[0]||null,last:pts[pts.length-1]||null})}

 /* recommended session stats */
 const rec={typicalSessionMin:durs.length?Math.round(pct(durs,.5)):PU.typicalSessionMin,
  typicalCycles:cycs.length?Math.round(pct(cycs,.5)):PU.typicalCycles,
  cycleOnMin:onLens.length?Math.round(pct(onLens,.5)):PU.cycleOnMin,
  cycleIdleMin:idleGaps.length?Math.round(pct(idleGaps,.5)):PU.cycleIdleMin};

 /* ± bands by predicted lead */
 const Q=PU.bandQuantile,edges=PU.bands.map(b=>b.maxLeadMin);
 const bucket=l=>{let i=0;while(i<edges.length-1&&l>edges[i])i++;return i};
 function bandsFrom(list){return edges.map((mx,i)=>{const a=list.filter(p=>bucket(p.lead)===i).map(p=>p.ae);return{maxLeadMin:mx,pm:a.length?Math.max(PU.minPmMin,Math.round(pct(a,Q))):null,n:a.length}})}
 const recBands=bandsFrom(allPts);
 for(let i=0;i<recBands.length;i++)if(recBands[i].pm===null)recBands[i].pm=i?recBands[i-1].pm:PU.minPmMin;
 for(let i=1;i<recBands.length;i++)recBands[i].pm=Math.max(recBands[i].pm,recBands[i-1].pm);
 const cov=(list,pmOf)=>{const ins=list.filter(p=>p.ae<=pmOf(p)).length;return list.length?ins/list.length:null};
 const covCfg=cov(allPts,p=>p.pm),covRec=cov(allPts,p=>recBands[bucket(p.lead)].pm);
 const bandsLine="bands:["+recBands.map(b=>"{maxLeadMin:"+b.maxLeadMin+",pm:"+b.pm+"}").join(",")+"],";
 const statsLine="typicalSessionMin:"+rec.typicalSessionMin+", typicalCycles:"+rec.typicalCycles+", cycleOnMin:"+rec.cycleOnMin+", cycleIdleMin:"+rec.cycleIdleMin+",";

 if(opt.json){console.log(JSON.stringify({version:PU.version,config:PU,recommended:rec,bands:recBands,coverage:{configured:covCfg,recommended:covRec},
  sessions:complete.map(({first,last,...x})=>x),overall:{n:allPts.length,median:pct(allPts.map(p=>p.ae),.5),p80:pct(allPts.map(p=>p.ae),.8),
   meanBias:allPts.length?allPts.reduce((a,p)=>a+p.e,0)/allPts.length:null}},null,1));return}

 console.log(`Ultimate cooling-done backtest · PREDICT_ULTIMATE ${PU.version} · blend ${PU.blend} · fudge ${PU.fudge}`);
 console.log(`Rows ${rows.length} (${dstr(rows[0].t)} → ${dstr(rows[rows.length-1].t)}); ultimate-off known to ±2.5 min (5-min log)\n`);
 console.log("Session start             ultimate off   end    cycles  preds  median|err|  p90|err|  first (lead, err)         last (lead, err)");
 for(const r of complete){
  if(!r.ultimate){console.log(`${dstr(r.start)} ${hm(r.start).padEnd(9)} (no ultimate — still cycling or cut by drive)  end=${r.endWhy}`);continue}
  const fp=r.first,lp=r.last;
  console.log(`${dstr(r.start)} ${hm(r.start).padEnd(9)} ${hm(r.ultimate).padEnd(12)} ${String(r.endWhy).padEnd(6)} ${String(r.cycles).padStart(6)}  ${String(r.n).padStart(5)}  ${r.med===null?"   --":r.med.toFixed(0).padStart(6)} min ${r.p90===null?"  --":r.p90.toFixed(0).padStart(6)} min  `+
   (fp?`${fp.lead.toFixed(0)} min, ${f1(fp.e)}`.padEnd(24):"--".padEnd(24))+(lp?` ${lp.lead.toFixed(0)} min, ${f1(lp.e)}`:" --"))}
 const aes=allPts.map(p=>p.ae),bias=allPts.map(p=>p.e);
 console.log(`\nOverall: ${allPts.length} predictions over ${complete.filter(r=>r.n).length} sessions with known ultimate · median |error| ${pct(aes,.5)?.toFixed(0)} min · p80 ${pct(aes,.8)?.toFixed(0)} min · mean bias ${bias.length?f1(bias.reduce((a,b)=>a+b,0)/bias.length):"--"} min (+ = predicted too late)`);
 console.log(`Session stats (median): duration→ultimate ${rec.typicalSessionMin} min · cycles ${rec.typicalCycles} · fan-on stretch ${rec.cycleOnMin} min · idle gap ${rec.cycleIdleMin} min`);
 console.log(`  (from ${durs.length} complete ultimates; on-stretches n=${onLens.length}, idle gaps n=${idleGaps.length})`);

 const pc=x=>x===null?"--":(100*x).toFixed(0)+"%";
 console.log(`\n± range (p${Math.round(Q*100)} |error|, by predicted lead):`);
 recBands.forEach((b,i)=>{const l=allPts.filter(p=>bucket(p.lead)===i);const c=cov(l,p=>b.pm);
  console.log(`  lead ≤ ${String(b.maxLeadMin===9999?"∞":b.maxLeadMin).padEnd(4)} min : ±${String(b.pm).padStart(3)} min   (n=${b.n}, coverage ${pc(c)})`)});
 console.log(`Coverage (actual ultimate inside shown range): configured ${PU.version} bands ${pc(covCfg)} · recommended ${pc(covRec)}`);
 console.log(`Paste into PREDICT_ULTIMATE (bump version):\n ${statsLine}\n ${bandsLine}`);
})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});
