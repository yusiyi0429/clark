import React,{useEffect,useRef} from 'react';
// Nexus 驻波弦 · 柔拨 (陈溪南 2026-10-27): five fine strings across a deep-blue glass orb, each vibrating in its own
// standing wave and fading out at both ends; every few seconds they are plucked softly (half a second up, two down,
// one string after another). One animation loop for every orb on the page (about 40 fps, paused while the tab is
// hidden, a still frame under reduced motion).
const COL=['255,255,255','140,220,255','120,160,255','190,160,255','110,240,240'];
const ease=p=>p<0?0:p>1?1:p*p*(3-2*p);
const pluck=(T,k)=>{const period=5,lag=k*.12,p=((T-lag)%period+period)%period,rise=.55,fall=2.2;return .9*(p<rise?ease(p/rise):p<rise+fall?1-ease((p-rise)/fall):0);};
const orbs=new Set();let raf=0,last=0;
function line(x,pts,grad,w){x.strokeStyle=grad;x.lineWidth=w;x.lineCap='round';x.lineJoin='round';x.beginPath();pts.forEach((p,i)=>i?x.lineTo(p[0],p[1]):x.moveTo(p[0],p[1]));x.stroke();}
function fade(x,a,b,col,al){const g=x.createLinearGradient(a[0],a[1],b[0],b[1]);g.addColorStop(0,`rgba(${col},0)`);g.addColorStop(.25,`rgba(${col},${al})`);g.addColorStop(.75,`rgba(${col},${al})`);g.addColorStop(1,`rgba(${col},0)`);return g;}
function drawOrb(o,t){
 const c=o.canvas,s=c.clientWidth;if(!s)return;const ratio=Math.min(3,Math.max(2,window.devicePixelRatio||1)),px=Math.round(s*ratio);if(c.width!==px)c.width=c.height=px;
 const x=c.getContext('2d'),r=s/2,T=t*.001,M=s>40?48:28,w=Math.max(.5,s*.011);x.setTransform(ratio,0,0,ratio,0,0);x.clearRect(0,0,s,s);x.save();x.beginPath();x.arc(r,r,r,0,6.2832);x.clip();
 const g=x.createRadialGradient(r*.6,r*.42,0,r,r,r);g.addColorStop(0,'#1c47d8');g.addColorStop(.6,'#0a2a92');g.addColorStop(1,'#04154f');x.fillStyle=g;x.fillRect(0,0,s,s);
 x.globalCompositeOperation='lighter';
 for(let k=0;k<5;k++){const mode=k%3+1,tilt=(k-2)*.16+Math.sin(T*.3+k)*.05,pl=pluck(T,k),amp=r*.18*(1+.35*Math.sin(T*.7+k))*(1+pl),pts=[];
  for(let i=0;i<=M;i++){const u=i/M,xx=-r*1.1+u*r*2.2,env=Math.sin(u*Math.PI);
   const y=((Math.sin(u*Math.PI*mode)*Math.sin(T*(1.2+k*.21)+k)+.35*Math.sin(u*Math.PI*(mode+2))*Math.sin(T*(2+k*.13)))*amp+Math.sin(u*Math.PI*3-T*3.2+k)*r*.035*pl)*env;
   pts.push([r+xx*Math.cos(tilt)-y*Math.sin(tilt),r+xx*Math.sin(tilt)+y*Math.cos(tilt)]);}
  const A=pts[0],B=pts[M],al=.9+.1*Math.min(1,pl);
  x.save();x.filter=`blur(${Math.max(.8,s*.025)}px)`;line(x,pts,fade(x,A,B,COL[k],al*(.4+.25*Math.min(1,pl))),w*3.2);x.restore();line(x,pts,fade(x,A,B,COL[k],al),w);}
 x.globalCompositeOperation='source-over';
 const e=x.createRadialGradient(r,r,r*.6,r,r,r);e.addColorStop(0,'rgba(0,0,0,0)');e.addColorStop(1,'rgba(2,10,45,.55)');x.fillStyle=e;x.fillRect(0,0,s,s);
 const h=x.createRadialGradient(r*.6,r*.34,0,r*.6,r*.34,r*.5);h.addColorStop(0,'rgba(255,255,255,.3)');h.addColorStop(1,'rgba(255,255,255,0)');x.fillStyle=h;x.fillRect(0,0,s,s);
 x.strokeStyle='rgba(255,255,255,.22)';x.lineWidth=Math.max(.5,s*.01);x.beginPath();x.arc(r,r,r-x.lineWidth/2,0,6.2832);x.stroke();x.restore();
}
const still=()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
function frame(t){raf=0;if(!orbs.size)return;if(!document.hidden&&t-last>=24){last=t;orbs.forEach(o=>drawOrb(o,t));}if(!still())raf=requestAnimationFrame(frame);}
function start(){if(raf)return;if(still())orbs.forEach(o=>drawOrb(o,1800));else raf=requestAnimationFrame(frame);}
export default function NexusOrb({className=''}){
 const ref=useRef(null);
 useEffect(()=>{const o={canvas:ref.current};orbs.add(o);drawOrb(o,performance.now());start();const ro=typeof ResizeObserver==='function'?new ResizeObserver(()=>drawOrb(o,performance.now())):null;ro?.observe(ref.current);
  return()=>{orbs.delete(o);ro?.disconnect();if(!orbs.size&&raf){cancelAnimationFrame(raf);raf=0;}};},[]);
 return <span className={`nexus-orb ${className}`} aria-hidden="true"><canvas ref={ref} className="nexus-orb-canvas"/></span>;
}
