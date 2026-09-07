'use strict'
const fs = require('fs')
const t = fs.readFileSync('app/admin/ui.js', 'utf8')
let out = t

function replaceOnce(str, anchor, replacement, label) {
  const parts = str.split(anchor)
  if (parts.length !== 2) throw new Error(`anchor not unique (${parts.length - 1} hits): ${label}`)
  return parts.join(replacement)
}

// 1) systems list: relabel Dentrix
out = replaceOnce(out, `['Dentrix','REST API']`, `['Dentrix','On-site ODBC bridge']`, 'systems entry')

// 2) Connectors: bridge state + loader + effect
const stateAnchor = `const[active,setActive]=useState(null),[saved,setSaved]=useState(()=>read('corinne-connectors',{})),[health,setHealth]=useState({})`
const stateReplacement = stateAnchor + `,const[bridge,setBridge]=useState({open:false,checked:false,status:null})
 const loadBridgeStatus=async()=>{try{const t=await idToken();const r=await fetch('/api/dentrix',{headers:{Authorization:\\`Bearer ${t}\\`},cache:'no-store'});const d=await r.json();setBridge(s=>({...s,checked:true,status:d}))}catch{setBridge(s=>({...s,checked:true,status:{ok:false,reachable:false,error:'Status check failed'}}))}}
 useEffect(()=>{loadBridgeStatus()},[])`
out = replaceOnce(out, stateAnchor, stateReplacement, 'connectors state')

// 3) card branch for Dentrix (early-return inside the systems.map)
const mapAnchor = `{systems.map(x=>{const cfg=saved[x[0]],h=cfg&&cfg.host?health[x[0]]:null,`
const mapReplacement = `{systems.map(x=>{if(x[0]==='Dentrix'){const b=!bridge.checked?'idle':bridge.status&&bridge.status.ok&&bridge.status.reachable?(bridge.status.db&&bridge.status.db.connected?'live':'cfgOn'):'down';const badge=b==='live'?['bg-emerald-100 text-emerald-700','Connected']:b==='cfgOn'?['bg-amber-100 text-amber-800','Bridge only · DB down']:b==='down'?['bg-red-100 text-red-700','Disconnected']:['bg-slate-100','Not configured'];const icon=b==='live'||b==='cfgOn'?'od-green':b==='down'?'od-red':'od-idle';return <div key={x[0]} className={\\`panel rounded-[20px] p-5 transition-shadow ${b==='live'||b==='cfgOn'?'ring-1 ring-emerald-200/70':b==='down'?'ring-1 ring-red-200/70':''}\\`}><div className="flex justify-between"><span className={icon}><PlugZap size={20}/></span><span className={\\`rounded-full px-2 py-1 text-[8px] font-bold ${badge[0]}\\`} title={(bridge.status&&bridge.status.error)||''}>{badge[1]}</span></div><h3 className="mt-4 text-sm font-bold">{x[0]}</h3><p className="mt-1 text-[9px] text-[#71878c]">c-treeACE ODBC · on-site bridge</p>{bridge.checked&&bridge.status&&!bridge.status.reachable&&<p className="mt-1 truncate text-[8px] text-red-500" title={bridge.status.error||''}>{bridge.status.error||'Bridge unreachable'}</p>}{bridge.checked&&bridge.status&&bridge.status.reachable&&!bridge.status.schemaMapped&&<p className="mt-1 truncate text-[8px] text-amber-600">Bridge up · schema not mapped yet</p>}<button onClick={()=>setBridge(s=>({...s,open:true}))} className="mt-4 text-[10px] font-bold text-[#147a76]">Configure bridge →</button></div>}}const cfg=saved[x[0]],h=cfg&&cfg.host?health[x[0]]:null,`
out = replaceOnce(out, mapAnchor, mapReplacement, 'dentrix card branch')

// 4) modal render
const modalAnchor = `{active&&<ConnectorConfig system={active} initial={saved[active[0]]} close={()=>setActive(null)} save={commit}/>}`
const modalReplacement = modalAnchor + `{bridge.open&&<DentrixConfig close={()=>setBridge(s=>({...s,open:false}))} refresh={loadBridgeStatus}/>}`
out = replaceOnce(out, modalAnchor, modalReplacement, 'modal render')

// 5) DentrixConfig component before ConnectorConfig
const compAnchor = `function ConnectorConfig({system,initial,close,save}){`
const comp = `function DentrixConfig({close,refresh}){
 const[url,setUrl]=useState(''),[token,setToken]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false),[test,setTest]=useState(null),[testing,setTesting]=useState(false)
 const save=async()=>{if(!url.trim()||!token.trim()){setError('Bridge URL and token are both required.');return}setBusy(true);setError('');try{const t=await idToken();const r=await fetch('/api/secrets',{method:'POST',headers:{'Content-Type':'application/json',Authorization:\\`Bearer ${t}\\`},body:JSON.stringify({dentrixBridgeUrl:url.trim(),dentrixBridgeToken:token.trim()})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Save failed.');setSaved(true);await refresh()}catch(e){setError(e.message)}finally{setBusy(false)}}
 const runTest=async()=>{setTesting(true);setTest(null);try{const t=await idToken();const r=await fetch('/api/dentrix',{headers:{Authorization:\\`Bearer ${t}\\`},cache:'no-store'});const d=await r.json();setTest(d.ok&&d.reachable?(d.db&&d.db.connected?{ok:true,msg:'Bridge reachable · database connected'}:{ok:true,msg:'Bridge reachable · database NOT connected — check bridge config on the practice machine'}):{ok:false,msg:d.error||'Bridge unreachable — save the credentials first, and confirm the tunnel is up.'})}catch(e){setTest({ok:false,msg:e.message})}finally{setTesting(false)}}
 return <Shell title="Configure Dentrix bridge" close={close}><div className="mt-5 space-y-4"><p className="rounded-xl bg-[#e7f0ef] p-3 text-[9px] leading-4">The bridge runs on a practice PC next to the Dentrix database (FairCom c-treeACE over ODBC) and exposes it read-only through an outbound-only tunnel — no router ports. Setup lives in the project bridge/README. The token is stored encrypted server-side.</p><label className="block text-[9px] font-bold">BRIDGE URL<input className="field mono mt-2 text-xs" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://corinne-bridge.trycloudflare.com"/></label><label className="block text-[9px] font-bold">BRIDGE TOKEN<input className="field mono mt-2 text-xs" type="password" value={token} onChange={e=>setToken(e.target.value)} placeholder="long random string from config.json"/></label>{saved&&<p className="rounded-lg bg-emerald-50 p-3 text-[9px] font-bold text-emerald-700">Bridge credentials saved — encrypted server-side. Run the probe on the practice machine and map the schema before pulling patients.</p>}{error&&<p className="rounded-lg bg-red-50 p-3 text-[9px] text-red-700">{error}</p>}{test&&<p className={\\`rounded-lg p-3 text-[9px] font-bold ${test.ok?'bg-emerald-50 text-emerald-700':'bg-red-50 text-red-700'}\\`}>{test.msg}</p>}<div className="flex gap-3"><button disabled={busy} onClick={save} className="flex-1 rounded-xl bg-[#147a76] py-3 text-xs font-bold text-white disabled:opacity-50">{busy?'Saving…':'Save'}</button><button disabled={testing||!saved} onClick={runTest} className="flex-1 rounded-xl border py-3 text-xs font-bold disabled:opacity-50">{testing?'Testing…':'Test connection'}</button></div><p className="text-center text-[8px] text-[#9ab0b4]">Save first — Test checks the saved credentials end to end.</p></div></Shell>
}
` + compAnchor
out = replaceOnce(out, compAnchor, comp, 'DentrixConfig component')

fs.writeFileSync('app/admin/ui.js', out)
console.log('patched ok. size', t.length, '->', out.length)
for (const probe of ['DentrixConfig', "['Dentrix','On-site ODBC bridge']", '/api/dentrix', 'loadBridgeStatus', 'Configure bridge']) {
  console.log(`"${probe}" hits:`, out.split(probe).length - 1)
}
