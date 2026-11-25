// Recipes 2.2 — search, categories, random, mutate, rename / duplicate / delete, export / import.
// Works on top of the existing grid (renderPresets): cards are tagged with a category computed from their effects,
// so the same recipe always lands in the same place. Recipes are plain look snapshots: no random values inside.
'use strict';
const Recipes=(()=>{
  const S=Live.part('rec',{q:'',cat:'ALL'});
  const CATS=['ALL','GLO','RAGE','DIGITAL','VHS','ORGANIC','PSYCHEDELIC','HARDCORE','AMBIENT','ABSTRACT','EXPERIMENTAL','MINE'];
  if(!CATS.includes(S.cat))S.cat='ALL';
  const LAB=new Set(FX.filter(f=>f.cat==='LAB').map(f=>f.id));
  // the strongest family of effects decides the category
  function category(src,user){
    const l=Live.toLook(src),on=FX.filter(f=>l.on[f.id]),v=id=>l.on[id]?l.fx[id]:0,sum=ids=>ids.reduce((a,id)=>a+v(id),0);
    if(on.some(f=>LAB.has(f.id)))return 'EXPERIMENTAL';
    const chaos=+l.m.chaos||0,speed=+l.m.speed||1;
    const sc={
      HARDCORE:(sum(['glitch','rgb','tear','skip'])>1.6&&chaos>.6)?3:0,
      RAGE:sum(['glitch','rgb','mosh','tear','skip'])*(.6+chaos),
      DIGITAL:sum(['comp','sort','post','mosh','ascii']),
      VHS:sum(['vhs','tear','ca'])+(v('dirt')*.5),
      ORGANIC:sum(['liquid','fluid','ripple','disp','fish']),
      PSYCHEDELIC:sum(['kaleido','prism','mirror','edge'])+(Math.abs(+l.m.hueShift||0)>60?.4:0),
      GLO:sum(['bloom','glare','ghost','fb'])+(v('edge')*.3),
      AMBIENT:(on.length<=3&&speed<.9)?1.2:0
    };
    let best='ABSTRACT',bv=.55;for(const k in sc)if(sc[k]>bv){bv=sc[k];best=k}
    return best;
  }
  const el={};
  function build(){
    const grid=$id('presetGrid');if(!grid||el.bar)return;
    const bar=Live.h('div',{class:'rec-bar'});
    el.q=Live.h('input',{type:'search',class:'live-input',placeholder:'search recipes','aria-label':'Search recipes',value:S.q});
    el.q.addEventListener('input',()=>{S.q=el.q.value;Live.save();filter()});
    bar.appendChild(el.q);
    el.cats=Live.h('div',{class:'live-seg rec-cats',role:'radiogroup','aria-label':'Recipe category'});
    CATS.forEach(c=>{const b=Live.h('button',{type:'button',class:'chip'+(c===S.cat?' on':''),'data-c':c,text:c,role:'radio','aria-checked':String(c===S.cat)});
      b.addEventListener('click',()=>{S.cat=c;Live.save();$$('.chip',el.cats).forEach(x=>{const on=x===b;x.classList.toggle('on',on);x.setAttribute('aria-checked',String(on))});filter()});el.cats.appendChild(b)});
    bar.appendChild(el.cats);
    const fileIn=Live.h('input',{type:'file',accept:'.json,application/json',hidden:true});
    fileIn.addEventListener('change',()=>{if(fileIn.files[0])importFile(fileIn.files[0]);fileIn.value=''});
    bar.appendChild(Live.h('div',{class:'btn-grid rec-acts'},[
      Live.btn('⚄ RANDOM',random),Live.btn('⟳ MUTATE',()=>Mutation.mutate()),
      Live.btn('RENAME',rename),Live.btn('DUPLICATE',duplicate),Live.btn('DELETE',del),
      Live.btn('EXPORT',exportAll),Live.btn('IMPORT',()=>fileIn.click())]));
    bar.appendChild(fileIn);
    el.note=Live.h('p',{class:'section-desc rec-note'});bar.appendChild(el.note);
    grid.parentNode.insertBefore(bar,grid);el.bar=bar;
  }
  // tag every card after each render, then filter
  function tag(){
    $$('#presetGrid .preset').forEach(card=>{
      const n=card.dataset.name,user=!!(DATA.userPresets&&DATA.userPresets[n]);
      const src=user?DATA.userPresets[n]:BUILTIN_PRESETS.find(p=>p.name===n);
      if(!src)return;card.dataset.cat=category(src,user);card.dataset.user=user?'1':'';
    });
    filter();
  }
  function filter(){
    const q=(S.q||'').trim().toLowerCase();let shown=0;
    $$('#presetGrid .preset').forEach(card=>{
      const okQ=!q||card.dataset.name.toLowerCase().includes(q)||(card.dataset.cat||'').toLowerCase().includes(q);
      const okC=S.cat==='ALL'||(S.cat==='MINE'?card.dataset.user==='1':card.dataset.cat===S.cat);
      const on=okQ&&okC;card.hidden=!on;if(on)shown++;
    });
    if(el.note)setTxt(el.note,shown?'':(LANG==='it'?'Nessuna ricetta qui. Salvane una o cambia filtro.':'No recipe here yet. Save one or change the filter.'));
  }
  const userName=()=>DATA.activePreset&&DATA.userPresets&&DATA.userPresets[DATA.activePreset]?DATA.activePreset:null;
  function random(){
    const cards=$$('#presetGrid .preset').filter(c=>!c.hidden);if(!cards.length)return;
    cards[Math.floor(Math.random()*cards.length)].click();
  }
  function rename(){
    const n=userName();if(!n)return toast(LANG==='it'?'<b>SCEGLI UNA TUA RICETTA</b> — le ricette di ROT non si rinominano':'<b>PICK ONE OF YOUR RECIPES</b> — built-in recipes keep their names');
    const t=(prompt(LANG==='it'?'Nuovo nome':'New name',n)||'').trim().slice(0,26);if(!t||t===n)return;
    if(DATA.userPresets[t])return toast('<b>NAME TAKEN</b>');
    DATA.userPresets[t]=DATA.userPresets[n];delete DATA.userPresets[n];DATA.activePreset=t;storeSet(PRESET_STORAGE_KEY,DATA.userPresets);renderPresets();
  }
  function duplicate(){
    const n=DATA.activePreset;if(!n)return toast(LANG==='it'?'<b>SCEGLI UNA RICETTA</b>':'<b>PICK A RECIPE FIRST</b>');
    const src=DATA.userPresets[n]||BUILTIN_PRESETS.find(p=>p.name===n);if(!src)return;
    let t=(n+' copy').slice(0,26),i=2;while(DATA.userPresets[t])t=(n.slice(0,20)+' copy '+i++);
    DATA.userPresets[t]=Live.toLook(src);storeSet(PRESET_STORAGE_KEY,DATA.userPresets);DATA.activePreset=t;renderPresets();toast('<b>DUPLICATED</b> — '+esc(t));
  }
  function del(){const n=userName();if(!n)return toast(LANG==='it'?'<b>SCEGLI UNA TUA RICETTA</b>':'<b>PICK ONE OF YOUR RECIPES</b>');if(confirm((LANG==='it'?'Eliminare ':'Delete ')+n+'?'))deleteCurrentPreset(n)}
  function exportAll(){
    const items={};Object.keys(DATA.userPresets||{}).forEach(n=>items[n]=Live.toLook(DATA.userPresets[n]));
    if(!Object.keys(items).length&&DATA.activePreset){const b=BUILTIN_PRESETS.find(p=>p.name===DATA.activePreset);if(b)items[b.name]=Live.toLook(b)}
    if(!Object.keys(items).length)items['My look']=snapshotLook();
    downloadBlob(new Blob([JSON.stringify({rot:'recipes',v:1,items},null,1)],{type:'application/json'}),'rot-recipes.json');
  }
  function importFile(file){
    const r=new FileReader();
    r.onload=()=>{
      try{
        const o=JSON.parse(r.result);let items=null;
        if(o&&o.rot==='recipes'&&o.items&&typeof o.items==='object')items=o.items;
        else if(o&&o.rot==='look'&&o.look)items={[String(o.name||'Imported look')]:o.look};
        if(!items)throw 0;
        let n=0;Object.keys(items).slice(0,200).forEach(k=>{const v=items[k];if(!v||typeof v!=='object')return;
          let name=String(k).replace(/[<>]/g,'').trim().slice(0,26)||'Imported';while(DATA.userPresets[name])name=(name.slice(0,22)+' +');
          DATA.userPresets[name]=Live.toLook(v);n++});
        storeSet(PRESET_STORAGE_KEY,DATA.userPresets);renderPresets();toast('<b>IMPORTED</b> — '+n+' recipes');
      }catch(e){toast('<b>NOT A ROT RECIPE FILE</b>')}
    };
    r.readAsText(file);
  }
  // keep the tags in sync with every render of the grid
  const base=window.renderPresets;
  if(typeof base==='function')window.renderPresets=function(){const r=base.apply(this,arguments);try{tag()}catch(e){}return r};
  build();tag();
  Live.addAction('recipe:random','Random recipe',random);
  return {category,filter,random,exportAll,importFile};
})();
