// MIDI control — Web MIDI in the browser, no driver or service. Knobs and faders (CC) drive any parameter;
// pads and keys (notes) fire actions or set a parameter to their velocity. MIDI Learn: pick a target, press
// LEARN, move the control. Mappings live in named profiles (saved here, exportable as a .json file).
// Browsers without Web MIDI (Safari, Firefox without the add-on) just show that it is unavailable.
'use strict';
const Midi=(()=>{
  const S=Live.part('midi',{profile:'Default',profiles:{Default:{maps:[]}},auto:false,device:'*',smooth:true});
  if(!S.profiles||typeof S.profiles!=='object'||!Object.keys(S.profiles).length)S.profiles={Default:{maps:[]}};
  // keep only well-formed profiles and mappings (damaged saved data must not stop the page)
  for(const k of Object.keys(S.profiles)){const p=S.profiles[k];
    if(!p||typeof p!=='object'||!Array.isArray(p.maps)){S.profiles[k]={maps:[]};continue}
    p.maps=p.maps.filter(m=>m&&(m.type==='cc'||m.type==='note')&&Number.isInteger(m.ch)&&Number.isInteger(m.num)&&typeof m.target==='string')}
  if(!Object.keys(S.profiles).length)S.profiles={Default:{maps:[]}};
  const runtime=new WeakMap(); // DOM rows and knob positions: never saved
  if(!S.profiles[S.profile])S.profile=Object.keys(S.profiles)[0];
  const supported=typeof navigator!=='undefined'&&typeof navigator.requestMIDIAccess==='function';
  let access=null,learning=null,lastMsgAt=0,status=supported?'off':'unsupported';
  const maps=()=>S.profiles[S.profile].maps;
  const NOTE=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const srcLabel=m=>(m.type==='cc'?'CC '+m.num:'NOTE '+NOTE[m.num%12]+(Math.floor(m.num/12)-1))+' · ch'+(m.ch+1);
  function targetLabel(t){
    if(t.startsWith('p:')){const p=Live.params.get(t.slice(2));return p?p.label:t}
    if(t.startsWith('a:')){const a=Live.actions.get(t.slice(2));return a?a.label:t}
    return t;
  }

  async function enable(){
    if(!supported){toast('<b>MIDI</b> — not available in this browser (use Chrome, Edge or Opera)');return}
    if(access)return;
    status='asking';sync();
    try{
      access=await navigator.requestMIDIAccess({sysex:false});
      access.onstatechange=()=>{bindInputs();sync()};
      bindInputs();status='on';S.auto=true;Live.save();
      toast('<b>MIDI ON</b> — '+inputs().length+' device(s)');
    }catch(e){status='denied';access=null;toast('<b>MIDI BLOCKED</b> — allow MIDI access for this site to use a controller')}
    sync();
  }
  const inputs=()=>access?[...access.inputs.values()]:[];
  // each input tags its messages with its name, so one device can be chosen
  function bindInputs(){inputs().forEach(i=>{i.onmidimessage=e=>{if(S.device!=='*'&&i.name!==S.device)return;onMsg(e)}});fillDevices()}

  function onMsg(e){
    const d=e.data;if(!d||d.length<2)return;
    const st=d[0]&0xf0,ch=d[0]&0x0f,num=d[1],val=d.length>2?d[2]:0;
    let type=null;
    if(st===0xb0)type='cc';
    else if(st===0x90&&val>0)type='note';
    else if(st===0x80||(st===0x90&&val===0))type='off';
    if(!type)return;
    lastMsgAt=performance.now();led();
    if(learning&&type!=='off'){finishLearn(type,ch,num);return}
    maps().forEach(m=>{
      if(m.ch!==ch||m.num!==num)return;
      if(type==='off'){if(m.type==='note'&&m.target.startsWith('p:')&&m.hold){setParam(m,0)}return}
      if(m.type!==type)return;
      const v=val/127;
      if(m.target.startsWith('p:'))setParam(m,v);
      else if(m.target.startsWith('a:')){
        // a knob fires its action when it crosses the middle going up
        if(type==='cc'){const rt=runtime.get(m)||{};const up=v>=.5&&!(rt.last>=.5);rt.last=v;runtime.set(m,rt);if(!up)return}
        Live.run(m.target.slice(2),type==='note'?Math.max(.3,v):1);
      }
      hit(m);
    });
  }
  function setParam(m,v){
    const p=Live.params.get(m.target.slice(2));if(!p)return;
    if(typeof Scenes!=='undefined')Scenes.cancel();
    const lo=m.min==null?0:m.min,hi=m.max==null?1:m.max;
    const id0=m.target.slice(2),to=lo+(hi-lo)*v;
    // knobs glide to the new value over a few frames (a 7-bit CC jumps in steps of 1/127)
    if(S.smooth&&m.type==='cc'){glide.set(id0,{p,to});if(!glide.has(id0+'#'))glide.set(id0+'#',p.get())}else p.set(to);
    const id=m.target.slice(2);
    const u=id.startsWith('m:')?UI.master&&UI.master[id.slice(2)]:id.startsWith('fx:')?UI.fx&&UI.fx[id.slice(3)]:null;
    const row=u&&(u.row||(u.input&&u.input.closest('.ctrl')));
    if(row){row.classList.add('midi-hit');clearTimeout(row._mt);row._mt=setTimeout(()=>row.classList.remove('midi-hit'),180)}
  }

  // ---- learn
  function startLearn(target,replace){
    if(!access){enable().then(()=>{if(access)startLearn(target,replace)});return}
    learning={target,replace};sync();
    toast('<b>MIDI LEARN</b> — move a knob or hit a pad');
  }
  function finishLearn(type,ch,num){
    const {target,replace}=learning;learning=null;
    const list=maps();
    // one control drives one thing: a control already mapped is reassigned
    for(let i=list.length-1;i>=0;i--){const m=list[i];if((m.type===type&&m.ch===ch&&m.num===num)||m===replace)list.splice(i,1)}
    list.push({type:type==='note'?'note':'cc',ch,num,target,min:0,max:1,hold:false});
    Live.save();render();sync();
    toast('<b>MAPPED</b> — '+esc(srcLabel({type,ch,num}))+' → '+esc(targetLabel(target)));
  }

  // ---- profiles
  function newProfile(copy){
    const n=(prompt(LANG==='it'?'Nome del profilo':'Profile name',copy?S.profile+' 2':'Controller')||'').trim().slice(0,24);
    if(!n)return;if(S.profiles[n])return toast('<b>NAME TAKEN</b>');
    S.profiles[n]={maps:copy?deep(maps()):[]};S.profile=n;Live.save();render();sync();
  }
  function delProfile(){
    if(Object.keys(S.profiles).length<=1)return toast('<b>KEEP ONE PROFILE</b>');
    if(!confirm((LANG==='it'?'Eliminare il profilo ':'Delete profile ')+S.profile+'?'))return;
    delete S.profiles[S.profile];S.profile=Object.keys(S.profiles)[0];Live.save();render();sync();
  }
  function exportProfile(){
    const blob=new Blob([JSON.stringify({rot:'midi',v:1,name:S.profile,maps:maps()},null,1)],{type:'application/json'});
    downloadBlob(blob,'rot-midi-'+S.profile.toLowerCase().replace(/[^a-z0-9]+/g,'-')+'.json');
  }
  function importProfile(file){
    const r=new FileReader();
    r.onload=()=>{
      try{
        const o=JSON.parse(r.result);if(!o||o.rot!=='midi'||!Array.isArray(o.maps))throw 0;
        const clean=o.maps.filter(m=>m&&(m.type==='cc'||m.type==='note')&&Number.isInteger(m.ch)&&m.ch>=0&&m.ch<16&&Number.isInteger(m.num)&&m.num>=0&&m.num<128&&typeof m.target==='string'&&/^(p|a):[\w:.-]{1,40}$/.test(m.target))
          .map(m=>({type:m.type,ch:m.ch,num:m.num,target:m.target,min:clamp(+m.min||0,0,1),max:clamp(m.max==null?1:+m.max,0,1),hold:!!m.hold}));
        let n=String(o.name||'Imported').replace(/[^\w \-]/g,'').trim().slice(0,24)||'Imported';while(S.profiles[n])n+=' +';
        S.profiles[n]={maps:clean};S.profile=n;Live.save();render();sync();toast('<b>PROFILE IMPORTED</b> — '+clean.length+' mappings');
      }catch(e){toast('<b>NOT A ROT MIDI FILE</b>')}
    };
    r.readAsText(file);
  }

  // ---- panel
  const el={};
  function targets(){
    const g={};
    Live.params.forEach(p=>{(g[p.group]=g[p.group]||[]).push(['p:'+p.id,p.label])});
    Live.actions.forEach(a=>{(g.Actions=g.Actions||[]).push(['a:'+a.id,a.label])});
    return g;
  }
  // targets come from every module's params and actions: refilled once all of them are loaded
  function fillTargets(){
    if(!el.target)return;const keep=el.target.value;el.target.innerHTML='';
    const g=targets();Object.keys(g).forEach(k=>{const og=Live.h('optgroup',{label:k});g[k].forEach(([v,t])=>og.appendChild(Live.h('option',{value:v,text:t})));el.target.appendChild(og)});
    if(keep)el.target.value=keep;
  }
  Live.on('ready',()=>{fillTargets();render()});
  function mount(host){
    const L=Live,sec=L.section('MIDI','','midiSec');el.note=sec.note;
    el.led=L.h('i',{class:'midi-led','aria-hidden':'true'});sec.querySelector('.section-head').appendChild(el.led);
    el.enable=L.btn('ENABLE MIDI',enable,'full');sec.appendChild(L.h('div',{class:'btn-grid'},[el.enable]));
    el.devs=L.h('p',{class:'section-desc midi-devs'});sec.appendChild(el.devs);
    el.dev=L.select('Device',[['*','All devices']],S.device,v=>{S.device=v;Live.save()});sec.appendChild(el.dev);
    sec.appendChild(L.sw('Smooth knob movements',S.smooth,v=>{S.smooth=v;Live.save()}));
    // learn row
    el.target=L.h('select',{'aria-label':'MIDI target'});fillTargets();
    el.learn=L.btn('LEARN',()=>{if(learning){learning=null;sync();return}startLearn(el.target.value)},'hot');
    sec.appendChild(L.h('div',{class:'ctrl'},[L.h('div',{class:'ctrl-top'},[L.h('span',{class:'ctrl-label',text:'Map a control to'})]),L.h('div',{class:'live-row'},[el.target,el.learn])]));
    el.list=L.h('div',{class:'midi-list',role:'list','aria-label':'MIDI mappings'});sec.appendChild(el.list);
    // profiles
    el.prof=L.select('Profile',[],S.profile,v=>{S.profile=v;Live.save();render()});sec.appendChild(el.prof);
    const fileIn=L.h('input',{type:'file',accept:'.json,application/json',hidden:true});
    fileIn.addEventListener('change',()=>{if(fileIn.files[0])importProfile(fileIn.files[0]);fileIn.value=''});
    sec.appendChild(L.h('div',{class:'btn-grid'},[L.btn('NEW',()=>newProfile(false)),L.btn('DUPLICATE',()=>newProfile(true)),L.btn('EXPORT',exportProfile),L.btn('IMPORT',()=>fileIn.click()),L.btn('RESET MAPPINGS',()=>{if(!maps().length)return;if(!confirm(LANG==='it'?'Cancellare tutte le mappature di questo profilo?':'Remove every mapping of this profile?'))return;maps().length=0;Live.save();render();sync()}),L.btn('DELETE PROFILE',delProfile)]));
    sec.appendChild(fileIn);
    host.appendChild(sec);render();sync();
    if(supported&&S.auto&&navigator.permissions&&navigator.permissions.query){
      // reconnect silently when the site already has MIDI permission
      navigator.permissions.query({name:'midi'}).then(r=>{if(r.state==='granted')enable()}).catch(()=>{});
    }
  }
  function render(){
    if(!el.list)return;el.list.innerHTML='';
    const list=maps();
    if(!list.length)el.list.appendChild(Live.h('p',{class:'section-desc',text:'No mappings yet: pick a target, press LEARN, then move a knob or hit a pad.'}));
    list.forEach(m=>{
      const row=Live.h('div',{class:'midi-row',role:'listitem'},[
        Live.h('b',{text:srcLabel(m)}),Live.h('span',{text:'→ '+targetLabel(m.target)}),
        Live.h('button',{type:'button',class:'icon-btn',title:'Learn again','aria-label':'Reassign '+srcLabel(m),text:'⟲',onclick:()=>startLearn(m.target,m)}),
        Live.h('button',{type:'button',class:'icon-btn',title:'Remove','aria-label':'Remove '+srcLabel(m),text:'✕',onclick:()=>{const i=list.indexOf(m);if(i>=0)list.splice(i,1);Live.save();render()}})
      ]);
      runtime.set(m,Object.assign(runtime.get(m)||{},{row}));el.list.appendChild(row);
    });
    const s=el.prof&&el.prof.sel;if(s){s.innerHTML='';Object.keys(S.profiles).forEach(n=>{const o=document.createElement('option');o.value=n;o.textContent=n;if(n===S.profile)o.selected=true;s.appendChild(o)})}
  }
  function hit(m){const r=(runtime.get(m)||{}).row;if(!r)return;r.classList.add('hit');clearTimeout(r._t);r._t=setTimeout(()=>r.classList.remove('hit'),160)}
  function led(){if(!el.led)return;el.led.classList.add('on');clearTimeout(el.led._t);el.led._t=setTimeout(()=>el.led.classList.remove('on'),90)}
  function sync(){
    if(!el.enable)return;
    el.enable.disabled=!supported||status==='on'||status==='asking';
    el.enable.textContent=!supported?'MIDI UNAVAILABLE':status==='on'?'MIDI ON':status==='asking'?'WAITING FOR PERMISSION…':status==='denied'?'RETRY MIDI':'ENABLE MIDI';
    const ins=inputs();
    el.devs.textContent=!supported?'Web MIDI is not available in this browser. Chrome, Edge and Opera support it.':
      status!=='on'?'Connect a controller, then enable MIDI.':(ins.length?ins.map(i=>'● '+i.name+(i.state==='connected'?'':' (off)')).join('   '):'No MIDI device connected.');
    el.learn.textContent=learning?'CANCEL':'LEARN';el.learn.classList.toggle('acid',!!learning);
    el.learn.disabled=!supported;
    setTxt(el.note,maps().length+' MAPS');
  }
  // CC smoothing: one glide per parameter, eased toward the last value received
  const glide=new Map();
  Live.addTicker(ctx=>{
    if(!glide.size)return;const k=1-Math.exp(-ctx.dt*22);
    for(const [id,g] of glide){if(id.endsWith('#'))continue;const cur=glide.get(id+'#');const nv=cur+(g.to-cur)*k;
      if(Math.abs(g.to-nv)<.002){g.p.set(g.to);glide.delete(id);glide.delete(id+'#')}else{g.p.set(nv);glide.set(id+'#',nv)}}
  });
  function fillDevices(){
    if(!el.dev)return;const s=el.dev.sel,names=[...new Set(inputs().map(i=>i.name))];s.innerHTML='';
    [['*',LANG==='it'?'Tutti i dispositivi':'All devices']].concat(names.map(n=>[n,n])).forEach(([v,t])=>{const o=document.createElement('option');o.value=v;o.textContent=t;s.appendChild(o)});
    s.value=names.includes(S.device)?S.device:'*';
  }
  return {mount,enable,startLearn,onMsg,get supported(){return supported},get maps(){return maps()},get settings(){return S}};
})();
