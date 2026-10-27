import React,{useEffect,useRef} from 'react';
// Nexus 透光烟云 (陈溪南 2026-10-27): the deep-blue orb with smoke that curls and thins out on its own, lit from the top
// left so it has thick and thin parts. One shared noise field per frame for every orb on the page (about 30 fps, paused
// while the tab is hidden, a still frame under reduced motion); each orb only redraws it at its own size.
const N=44;
const H=new Uint8Array(512);for(let i=0;i<256;i++)H[i]=i;for(let i=255;i>0;i--){const j=Math.floor(Math.random()*(i+1));[H[i],H[j]]=[H[j],H[i]];}for(let i=0;i<256;i++)H[i+256]=H[i];
const fade=t=>t*t*(3-2*t),lerp=(a,b,t)=>a+(b-a)*t,h=(a,b,c)=>H[H[H[a]+b]+c]/255;
function noise(x,y,z){const X=Math.floor(x)&255,Y=Math.floor(y)&255,Z=Math.floor(z)&255;x-=Math.floor(x);y-=Math.floor(y);z-=Math.floor(z);const u=fade(x),v=fade(y),w=fade(z);
 return lerp(lerp(lerp(h(X,Y,Z),h(X+1,Y,Z),u),lerp(h(X,Y+1,Z),h(X+1,Y+1,Z),u),v),lerp(lerp(h(X,Y,Z+1),h(X+1,Y,Z+1),u),lerp(h(X,Y+1,Z+1),h(X+1,Y+1,Z+1),u),v),w);}
const fbm=(x,y,z)=>noise(x,y,z)*.55+noise(x*2.1,y*2.1,z*1.3)*.3+noise(x*4.3,y*4.3,z*1.7)*.15;
const orbs=new Set(),field=new Float32Array(N*N);let smoke=null,raf=0,last=0;
function paintSmoke(t){
 if(!smoke){smoke=document.createElement('canvas');smoke.width=smoke.height=N;}
 const z=t*.00018,cx=smoke.getContext('2d'),img=cx.createImageData(N,N),d=img.data;
 for(let j=0;j<N;j++)for(let i=0;i<N;i++){const px=i/N*2.3,py=j/N*2.3,qx=fbm(px+z*.6,py,z),qy=fbm(px+5.2,py+1.3-z*.4,z);field[j*N+i]=Math.max(0,Math.min(1,(fbm(px+1.8*qx+z*.3,py+1.8*qy,z*1.4)-.4)*2.4));}
 for(let j=0;j<N;j++)for(let i=0;i<N;i++){const k=j*N+i,a=field[k],up=j&&i?field[k-1-N]:a,lit=.55+.45*Math.max(-1,Math.min(1,(a-up)*5+.6))*(1-(i+j)/(2*N)*.5);
  d[k*4]=Math.min(255,(200+55*a)*lit+20);d[k*4+1]=Math.min(255,(225+30*a)*lit+15);d[k*4+2]=255;d[k*4+3]=Math.pow(a,1.25)*235*(.7+.3*lit);}
 cx.putImageData(img,0,0);
}
function drawOrb(o){
 const {canvas:c}=o,s=c.clientWidth;if(!s)return;const ratio=Math.min(3,Math.max(2,window.devicePixelRatio||1)),px=Math.round(s*ratio);
 if(c.width!==px){c.width=c.height=px;}const x=c.getContext('2d'),r=s/2;x.setTransform(ratio,0,0,ratio,0,0);x.clearRect(0,0,s,s);x.save();x.beginPath();x.arc(r,r,r,0,6.2832);x.clip();
 const g=x.createRadialGradient(r*.64,r*.44,0,r,r,r);g.addColorStop(0,'#3166ff');g.addColorStop(.35,'#063ed1');g.addColorStop(.65,'#002fa7');g.addColorStop(1,'#001b65');x.fillStyle=g;x.fillRect(0,0,s,s);
 x.globalCompositeOperation='lighter';x.save();x.filter=`blur(${Math.max(.6,s*.018)}px)`;x.imageSmoothingEnabled=true;x.drawImage(smoke,-s*.05,-s*.05,s*1.1,s*1.1);x.restore();
 const lg=x.createRadialGradient(r*.45,r*.32,0,r*.45,r*.32,r*.8);lg.addColorStop(0,'rgba(200,225,255,.18)');lg.addColorStop(1,'rgba(200,225,255,0)');x.fillStyle=lg;x.fillRect(0,0,s,s);
 x.globalCompositeOperation='source-over';
 const sh=x.createRadialGradient(r*.62,r*.5,0,r*.62,r*.5,r*.5);sh.addColorStop(0,'rgba(124,175,255,.22)');sh.addColorStop(1,'rgba(124,175,255,0)');x.fillStyle=sh;x.fillRect(0,0,s,s);
 const e=x.createRadialGradient(r*1.15,r*1.15,r*.5,r,r,r*1.05);e.addColorStop(0,'rgba(0,20,79,0)');e.addColorStop(1,'rgba(0,20,79,.6)');x.fillStyle=e;x.fillRect(0,0,s,s);
 x.strokeStyle='rgba(160,200,255,.25)';x.lineWidth=Math.max(.5,s*.012);x.beginPath();x.arc(r,r,r-x.lineWidth/2,3.6,5.4);x.stroke();x.restore();
}
const still=()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
function frame(t){raf=0;if(!orbs.size)return;if(!document.hidden&&t-last>=33){last=t;paintSmoke(t);orbs.forEach(drawOrb);}if(!still())raf=requestAnimationFrame(frame);}
function start(){if(!raf){if(still()){paintSmoke(8000);orbs.forEach(drawOrb);}else raf=requestAnimationFrame(frame);}}
export default function NexusOrb({className=''}){
 const ref=useRef(null);
 useEffect(()=>{const o={canvas:ref.current};orbs.add(o);if(smoke)drawOrb(o);start();const ro=typeof ResizeObserver==='function'?new ResizeObserver(()=>smoke&&drawOrb(o)):null;ro?.observe(ref.current);
  return()=>{orbs.delete(o);ro?.disconnect();if(!orbs.size&&raf){cancelAnimationFrame(raf);raf=0;}};},[]);
 return <span className={`nexus-orb ${className}`} aria-hidden="true"><canvas ref={ref} className="nexus-orb-canvas"/></span>;
}
