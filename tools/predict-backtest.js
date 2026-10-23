#!/usr/bin/env node
/* Backtest the app's fan-off prediction against the real Pack log.
   Loads PREDICT + predictOff() straight from app/index.html (the PREDICT-BEGIN ... PREDICT-END block),
   so the backtest always uses the same config the app ships.
   Usage: node tools/predict-backtest.js [--from 2026-10-16] [--to 2026-10-24] [--csv file.csv] [--set key=value ...] [--json]
   Default source: the Pack log CSV export the app fetches (public sheet). Times shown in the box's local zone (Perth). */
"use strict";
const fs=require("fs"),path=require("path"),vm=require("vm");
const SHEET="10Xp3xuxtlholYFS-oJ5VRpQiAplPkU5YD3JqET3iA_A";
const URL="https://docs.google.com/spreadsheets/d/"+SHEET+"/export?format=csv";
const args=process.argv.slice(2),opt={set:[]};
for(let i=0;i<args.length;i++){const a=args[i];if(a==="--json")opt.json=true;else if(a==="--set")opt.set.push(args[++i]);else if(a.startsWith("--"))opt[a.slice(2)]=args[++i]}

const html=fs.readFileSync(path.join(__dirname,"..","app","index.html"),"utf8");
const m=/\/\*PREDICT-BEGIN[\s\S]*?\/\*PREDICT-END\*\//.exec(html);
if(!m){console.error("PREDICT block not found in app/index.html");process.exit(1)}
const ctx={};vm.createContext(ctx);vm.runInContext(m[0]+";this.PREDICT=PREDICT;this.predictOff=predictOff;",ctx);
const P=ctx.PREDICT;
for(const kv of opt.set){const [k,v]=kv.split("=");P[k]=isNaN(+v)?v:+v}

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
 const from=opt.from?new Date(opt.from+"T00:00:00").getTime():-Infinity,to=opt.to?new Date(opt.to+"T23:59:59").getTime():Infinity;

 /* fan-on stretches (same gap rule as the app: rows ≤20 min apart) */
 const S=[];let cur=null;
 rows.forEach((r,i)=>{if(r.fan===1){if(!cur||r.t-rows[i-1].t>20*60e3||rows[i-1].fan!==1){cur={s:i,e:i};S.push(cur)}else cur.e=i}else cur=null});
 const res=[];
 for(const st of S){const last=rows[st.e],nxt=rows[st.e+1];
  if(rows[st.s].t<from||rows[st.s].t>to)continue;
  if(!nxt||nxt.fan!==0||nxt.t-last.t>20*60e3)continue;           /* still running or a data gap: no ground truth */
  const actual=(last.t+nxt.t)/2,res5=(nxt.t-last.t)/2/60e3;     /* fan turned off somewhere between the two rows */
  let mode="";const modes=new Set(),errs=[],pts=[];let hitAct=null;
  for(let i=st.s;i<=st.e;i++){if(rows[i].mode)mode=rows[i].mode;modes.add(mode);
   if(hitAct===null&&/^(run-on|cooldown-done|early-stop)$/.test(rows[i].mode))hitAct=rows[i].t;
   const p=ctx.predictOff(rows.slice(0,i+1),P);
   if(p.state==="ok"){const e=(p.t-actual)/60e3,lead=(actual-rows[i].t)/60e3;errs.push(Math.abs(e));pts.push({at:rows[i].t,lead,e,conf:p.conf,model:p.model})}}
  const endWhy=modes.has("early-stop")?"early-stop":modes.has("run-on")?"stop point + run-on":modes.has("backstop")?"backstop":[...modes].pop();
  if(![...modes].some(x=>P.modes.indexOf(x)>=0))continue;      /* stretch never in a predictable mode */
  res.push({start:rows[st.s].t,actual,res5,modes:[...modes].filter(Boolean),end:endWhy,n:pts.length,
   med:pct(errs,.5),p90:pct(errs,.9),first:pts[0]||null,last:pts[pts.length-1]||null,pts})}

 const all=res.flatMap(r=>r.pts.map(p=>Math.abs(p.e))),bias=res.flatMap(r=>r.pts.map(p=>p.e));
 const byConf={};res.forEach(r=>r.pts.forEach(p=>{(byConf[p.conf]=byConf[p.conf]||[]).push(Math.abs(p.e))}));
 const byLead={"<=30 min ahead":[],"30-60 min":[],">60 min":[]};
 res.forEach(r=>r.pts.forEach(p=>byLead[p.lead<=30?"<=30 min ahead":p.lead<=60?"30-60 min":">60 min"].push(Math.abs(p.e))));
 if(opt.json){console.log(JSON.stringify({version:P.version,config:P,stretches:res.map(({pts,...x})=>x),overall:{n:all.length,median:pct(all,.5),p90:pct(all,.9),meanBias:bias.length?bias.reduce((a,b)=>a+b,0)/bias.length:null}},null,1));return}
 console.log(`Fan-off prediction backtest · PREDICT ${P.version} · model ${P.model} · window ${P.windowMin} min · fudge ${P.fudge}`);
 console.log(`Rows ${rows.length} (${dstr(rows[0].t)} → ${dstr(rows[rows.length-1].t)}); fan-off time known to ±2.5 min (5-min log)\n`);
 console.log("Fan-on stretch            ended by                actual off   preds  median|err|  p90|err|  first pred (lead, err)   last pred (lead, err)");
 for(const r of res){const fp=r.first,lp=r.last;
  console.log(`${dstr(r.start)} ${hm(r.start).padEnd(9)} ${r.end.padEnd(22).slice(0,22)}  ${hm(r.actual).padEnd(11)} ${String(r.n).padStart(5)}  ${r.med===null?"   --":r.med.toFixed(1).padStart(6)} min ${r.p90===null?"  --":r.p90.toFixed(1).padStart(6)} min  `+
   (fp?`${fp.lead.toFixed(0)} min, ${f1(fp.e)} (${fp.conf})`.padEnd(24):"--".padEnd(24))+(lp?` ${lp.lead.toFixed(0)} min, ${f1(lp.e)} (${lp.conf})`:" --"))}
 console.log(`\nOverall: ${all.length} predictions over ${res.filter(r=>r.n).length} stretches · median |error| ${pct(all,.5)?.toFixed(1)} min · p90 ${pct(all,.9)?.toFixed(1)} min · mean bias ${bias.length?f1(bias.reduce((a,b)=>a+b,0)/bias.length):"--"} min (+ = predicted too late)`);
 for(const k of ["high","med","low"])if(byConf[k])console.log(`  confidence ${k.padEnd(4)}: n=${byConf[k].length} median ${pct(byConf[k],.5).toFixed(1)} p90 ${pct(byConf[k],.9).toFixed(1)} min`);
 for(const k in byLead)if(byLead[k].length)console.log(`  ${k.padEnd(15)}: n=${byLead[k].length} median ${pct(byLead[k],.5).toFixed(1)} p90 ${pct(byLead[k],.9).toFixed(1)} min`);
})().catch(e=>{console.error(e.message);process.exit(1)});
