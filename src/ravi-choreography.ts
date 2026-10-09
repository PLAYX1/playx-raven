/** Deterministic choreography in SVG units; never reads wallet or user data. */
export const OPENING_MS = 2400;
export const REDUCED_OPENING_MS = 220;
export type RaviFrame = { x:number; y:number; roll:number; wing:number; wave:number; head:number; tail:number; feet:number; body:number; eye:number; beak:number; opacity:number };
export const neutralFrame = (): RaviFrame => ({ x:0,y:0,roll:0,wing:0,wave:0,head:0,tail:0,feet:0,body:0,eye:1,beak:0,opacity:1 });
const clamp = (x:number) => Math.max(0, Math.min(1,x));
const smooth = (x:number) => { const t=clamp(x); return t*t*(3-2*t); };
const pulse = (t:number, from:number, to:number) => t>from&&t<to ? Math.sin((t-from)/(to-from)*Math.PI) : 0;
export function cubic(a:number,b:number,c:number,d:number,t:number):number {
  const u=clamp(t),v=1-u;return v*v*v*a+3*v*v*u*b+3*v*u*u*c+u*u*u*d;
}
export function openingFrame(ms:number,reduced=false):RaviFrame {
  const f=neutralFrame(), t=Math.max(0,ms)/1000;
  if(reduced){f.opacity=smooth(ms/REDUCED_OPENING_MS);f.head=-3;return f;}
  if(t<1.18){
    // Ease-out follows a cubic arc; its tangent supplies banking, not a canned rotation.
    const u=1-(1-clamp(t/1.18))**2;
    f.x=cubic(-480,-320,-35,0,u);f.y=cubic(-150,-330,-70,0,u);
    const du=2*(1-clamp(t/1.18))/1.18;
    const dx=(3*(1-u)**2*160+6*(1-u)*u*285+3*u*u*35)*du;
    const dy=(3*(1-u)**2*-180+6*(1-u)*u*260+3*u*u*70)*du;
    f.roll=Math.atan2(dy,Math.max(1,dx))*180/Math.PI*Math.min(1,dx/450)*.45;
    const brake=smooth((t-.78)/.32);
    f.wing=(36+28*Math.sin(t*Math.PI*2*4.5))*(1-brake)+76*brake;
    f.tail=-f.roll*.6-14*brake; f.feet=10*smooth((t-.82)/.25);
    f.body=-f.feet;f.opacity=smooth(t/.12);
  } else {
    // Feet touch at 1.18s, then two diminishing hops, a feather shake and a greeting.
    f.y=-19*pulse(t,1.18,1.43)-7*pulse(t,1.43,1.61);
    f.body=5*pulse(t,1.18,1.28)+2*pulse(t,1.43,1.50);
    f.wing=76*(1-smooth((t-1.18)/.32));
    const shake=pulse(t,1.61,1.84);
    f.roll=3*Math.sin(t*65)*shake;f.tail=12*Math.sin(t*55)*shake;
    f.head=-9*pulse(t,1.82,2.18);f.eye=1-pulse(t,1.83,1.98);
    f.wave=(38+13*Math.sin((t-2.0)*Math.PI*12))*pulse(t,1.98,2.4);
  }
  return f;
}
export function farewellFrame(ms:number,reduced=false):RaviFrame {
  const f=neutralFrame(),t=clamp(ms/(reduced?180:760));
  f.wave=reduced?0:(36+12*Math.sin(t*18))*Math.sin(Math.PI*t);
  f.eye=1-smooth((t-.45)/.55);f.head=7*smooth(t);return f;
}
export function restingFrame(ms:number,reduced=false):RaviFrame {
  const f=neutralFrame(),t=(ms/1000)%24;
  f.eye=0;f.head=6;
  if(reduced)return f;
  const look=pulse(t,8,11),stretch=pulse(t,16,19),yawn=pulse(t,18,20);
  f.eye=look*.85;f.head=6-12*look;f.wing=32*stretch;f.body=-3*stretch;
  f.beak=yawn*.8;f.tail=5*stretch;f.y=Math.sin(ms/1000*.7)*1.3;
  return f;
}
