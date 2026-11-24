// Motion 2 — a richer motion language on top of the page's own (index.html: Motion.stagger / Motion.tick).
// Everything here animates transform, opacity or a small clip-path only, through the Web Animations API, so the
// compositor does the work and the WebGL canvas keeps its frames. Springs are real damped-spring curves turned
// into a CSS linear() easing (with a cubic-bezier fallback). All of it is skipped with reduced motion or safe mode.
//   · dialogs grow out of the button that opened them and fold back into it
//   · the active tab / bottom-nav pill slides between items on a spring
//   · grids cascade as a wave from the point you touched
//   · titles wipe in behind a scan line
//   · toasts spring in and the others glide into place when one leaves
//   · primary buttons lean toward the pointer
//   · changing values roll like a counter
'use strict';
const Motion2=(()=>{
  const ok=()=>Motion.ok();
  // ---- springs
  function springCurve(stiff,damp,mass){
    const pts=[];let x=0,v=0,t=0;const dt=1/120;
    for(;t<3;t+=dt){const a=(-stiff*(x-1)-damp*v)/mass;v+=a*dt;x+=v*dt;pts.push(x);if(t>.25&&Math.abs(x-1)<.0008&&Math.abs(v)<.01)break}
    const n=Math.min(48,pts.length),step=(pts.length-1)/(n-1),out=[];
    for(let i=0;i<n;i++)out.push(+pts[Math.round(i*step)].toFixed(4));
    out[out.length-1]=1;
    return {easing:'linear('+out.join(',')+')',ms:Math.round(t*1000)};
  }
  const hasLinear=(()=>{try{return CSS.supports('animation-timing-function','linear(0, 1)')}catch(e){return false}})();
  const SP={
    soft:hasLinear?springCurve(170,20,1):{easing:'cubic-bezier(.2,1.25,.32,1)',ms:620},
    snappy:hasLinear?springCurve(320,24,1):{easing:'cubic-bezier(.2,1.35,.3,1)',ms:420},
    bouncy:hasLinear?springCurve(260,14,1):{easing:'cubic-bezier(.18,1.6,.3,1)',ms:700}
  };
  document.documentElement.style.setProperty('--spring',SP.soft.easing);
  document.documentElement.style.setProperty('--spring-ms',SP.soft.ms+'ms');
  const anim=(el,kf,sp,extra)=>el&&el.animate?el.animate(kf,Object.assign({duration:sp.ms,easing:sp.easing,fill:'none'},extra||{})):null;

  // ---- where the last touch / click happened (dialogs grow from it, grids ripple from it)
  const P={x:innerWidth/2,y:innerHeight/2,at:0,el:null};
  addEventListener('pointerdown',e=>{P.x=e.clientX;P.y=e.clientY;P.at=performance.now();P.el=e.target},{capture:true,passive:true});
  const recent=()=>performance.now()-P.at<900;

  // ---- dialogs: grow out of the opener, fold back into it
  const DIALOGS=[['#gen','.gen-card'],['#keys','.ks-card'],['#qclip','.live-card'],['#qplay','.live-card'],['#gal','.gal-card'],['#viewer','.viewer-card']];
  const opened=new WeakMap();
  function openFx(root,card){
    if(!ok()||!card)return;
    const r=card.getBoundingClientRect();if(!r.width)return;
    const from=recent()?{x:P.x,y:P.y}:{x:innerWidth/2,y:innerHeight*.62};
    const dx=from.x-(r.left+r.width/2),dy=from.y-(r.top+r.height/2);
    opened.set(root,from);
    anim(card,[
      {transform:`translate3d(${dx}px,${dy}px,0) scale(.18)`,opacity:0,borderRadius:'48px'},
      {opacity:1,offset:.22},
      {transform:'translate3d(0,0,0) scale(1)',opacity:1,borderRadius:getComputedStyle(card).borderRadius}
    ],SP.soft);
    // its content follows a beat later
    const kids=[...card.children].slice(0,10);
    kids.forEach((k,i)=>anim(k,[{transform:'translate3d(0,10px,0)',opacity:0},{transform:'none',opacity:1}],SP.snappy,{delay:90+i*34,fill:'backwards'}));
    const h=card.querySelector('h2');if(h)wipe(h,140);
  }
  function closeFx(root,card){
    if(!ok()||!card)return;
    const from=opened.get(root);const r=card.getBoundingClientRect();if(!r.width)return;
    const dx=from?from.x-(r.left+r.width/2):0,dy=from?from.y-(r.top+r.height/2):24;
    anim(card,[{transform:'none',opacity:1},{transform:`translate3d(${dx*.6}px,${dy*.6}px,0) scale(.4)`,opacity:0}],{ms:260,easing:'cubic-bezier(.5,0,.75,0)'},{fill:'forwards'})
      .finished.then(a=>{try{a.cancel()}catch(e){}}).catch(()=>{});
  }
  function watchDialogs(){
    DIALOGS.forEach(([rs,cs])=>{
      const root=$(rs);if(!root||root._mo2)return;root._mo2=true;
      let on=root.classList.contains('on');
      new MutationObserver(()=>{const now=root.classList.contains('on');if(now===on)return;on=now;const card=root.querySelector(cs);now?openFx(root,card):closeFx(root,card)})
        .observe(root,{attributes:true,attributeFilter:['class']});
    });
  }

  // ---- sliding pill under the active tab / bottom-nav item
  function pill(container,itemSel,cls){
    if(!container||container.querySelector('.'+cls))return;
    const ind=document.createElement('i');ind.className=cls;ind.setAttribute('aria-hidden','true');
    container.insertBefore(ind,container.firstChild);container.classList.add('has-ind');
    let last=null;
    const place=animate=>{
      const on=container.querySelector(itemSel+'.on');
      if(!on||!on.offsetParent){ind.style.opacity='0';last=null;return}
      const x=on.offsetLeft,y=on.offsetTop,w=on.offsetWidth,h=on.offsetHeight;
      const to=`translate3d(${x}px,${y}px,0)`;
      ind.style.opacity='1';ind.style.width=w+'px';ind.style.height=h+'px';
      if(animate&&last&&ok()&&(last.x!==x||last.w!==w)){
        // stretch toward the destination, then settle: reads as one elastic move
        const sx=Math.max(1,(Math.abs(x-last.x)+w)/w)*.5+.5;
        anim(ind,[{transform:`translate3d(${last.x}px,${last.y}px,0) scaleX(${last.w/w})`},{transform:`translate3d(${(x+last.x)/2}px,${y}px,0) scaleX(${sx})`,offset:.35},{transform:to+' scaleX(1)'}],SP.soft);
      }
      ind.style.transform=to;last={x,y,w};
    };
    new MutationObserver(()=>place(true)).observe(container,{subtree:true,attributes:true,attributeFilter:['class']});
    addEventListener('resize',()=>place(false));
    new ResizeObserver(()=>place(false)).observe(container);
    place(false);
  }

  // ---- grids ripple out from the touch point
  const baseStagger=Motion.stagger.bind(Motion),centres=new WeakMap();
  Motion.stagger=function(root,max){
    if(!root||!ok())return baseStagger(root,max);
    const kids=[...root.children];if(kids.length<4)return baseStagger(root,max);
    const rr=root.getBoundingClientRect();
    const near=recent()&&P.x>rr.left-80&&P.x<rr.right+80&&P.y>rr.top-200&&P.y<rr.bottom+80;
    const ox=(near?P.x:rr.left)-rr.left,oy=(near?P.y:rr.top)-rr.top;
    // child centres relative to the grid, measured once per grid size (no per-child layout reads afterwards)
    let c=centres.get(root);
    if(!c||c.n!==kids.length||c.w!==Math.round(rr.width)){
      c={n:kids.length,w:Math.round(rr.width),p:kids.map(k=>{const r=k.getBoundingClientRect();return [r.left+r.width/2-rr.left,r.top+r.height/2-rr.top]})};
      centres.set(root,c);
    }
    const d=c.p.map(([x,y])=>Math.hypot(x-ox,y-oy));
    const lim=max||14,mx=Math.max(1,...d);
    // one read pass, one write pass, one restart (same cost as the plain cascade)
    kids.forEach((k,i)=>k.style.setProperty('--i',(d[i]/mx*lim).toFixed(2)));
    root.classList.remove('mo-in');void root.offsetWidth;root.classList.add('mo-in');
    clearTimeout(root._moT);root._moT=setTimeout(()=>root.classList.remove('mo-in'),1500);
    root.querySelectorAll(':scope > .section .section-title b,:scope .section-title b').forEach((b,i)=>{if(i<4)wipe(b,120+i*60)});
  };

  // ---- title wipe behind a scan line
  function wipe(el,delay){
    if(!ok()||!el||!el.animate)return;
    el.classList.add('mo2-wipe');
    anim(el,[{clipPath:'inset(0 100% 0 0)',transform:'translate3d(-6px,0,0)'},{clipPath:'inset(0 0% 0 0)',transform:'none'}],{ms:520,easing:'cubic-bezier(.65,0,.35,1)'},{delay:delay||0,fill:'backwards'});
    el.style.setProperty('--wd',(delay||0)+'ms');el.style.setProperty('--sw',Math.round(el.offsetWidth)+'px');
    el.classList.remove('mo2-scan');void el.offsetWidth;el.classList.add('mo2-scan');
    clearTimeout(el._wt);el._wt=setTimeout(()=>el.classList.remove('mo2-scan'),(delay||0)+700);
  }

  // ---- toasts: spring in, the others glide when one leaves
  function watchToasts(){
    const host=$id('toasts');if(!host)return;
    let rects=null;
    new MutationObserver(list=>{
      for(const m of list){
        if(m.type==='attributes'&&m.target.classList.contains('out')&&!rects){
          rects=new Map([...host.children].map(c=>[c,c.getBoundingClientRect().top]));
        }
        if(m.type==='childList'){
          m.addedNodes.forEach(n=>{if(n.nodeType===1&&ok())anim(n,[{transform:'translate3d(0,26px,0) scale(.86)',opacity:0},{transform:'none',opacity:1}],SP.bouncy)});
          if(m.removedNodes.length&&rects&&ok()){
            [...host.children].forEach(c=>{const was=rects.get(c);if(was==null)return;const dy=was-c.getBoundingClientRect().top;if(Math.abs(dy)>1)anim(c,[{transform:`translate3d(0,${dy}px,0)`},{transform:'none'}],SP.snappy)});
          }
          if(m.removedNodes.length)rects=null;
        }
      }
    }).observe(host,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  }

  // ---- primary buttons lean toward the pointer (fine pointers only)
  const MAG='.btn.hot,.btn.acid,#btnQuick,.tc-next,.qp-style.on,#apToggle';
  let magEl=null,magRaf=0,mx=0,my=0;
  function magnet(){
    if(!matchMedia('(pointer:fine)').matches)return;
    document.addEventListener('pointermove',e=>{
      const t=e.target.closest&&e.target.closest(MAG);
      if(t!==magEl){if(magEl){magEl.style.translate='';magEl.classList.remove('mo2-mag')}magEl=t&&ok()?t:null;if(magEl)magEl.classList.add('mo2-mag')}
      if(!magEl)return;mx=e.clientX;my=e.clientY;
      if(!magRaf)magRaf=requestAnimationFrame(()=>{magRaf=0;if(!magEl)return;const r=magEl.getBoundingClientRect();
        const dx=(mx-(r.left+r.width/2))/r.width,dy=(my-(r.top+r.height/2))/r.height;
        magEl.style.translate=(dx*7).toFixed(1)+'px '+(dy*5).toFixed(1)+'px';magEl.style.setProperty('--mx',((dx+.5)*100).toFixed(0)+'%')});
    },{passive:true});
  }

  // ---- values roll like a counter
  const baseTick=Motion.tick.bind(Motion);
  Motion.tick=function(el){
    if(!el||!ok()||!el.animate)return baseTick(el);
    anim(el,[{transform:'translate3d(0,-70%,0)',opacity:0},{transform:'translate3d(0,8%,0)',opacity:1,offset:.6},{transform:'none',opacity:1}],SP.snappy);
  };

  function init(){
    watchDialogs();watchToasts();magnet();
    pill($('#panelRight .tabs'),'.tab','tab-ind');
    pill($id('bottomNav'),'.bnav','bnav-ind');
  }
  return {init,spring:SP,wipe,springCurve};
})();
Motion2.init();
