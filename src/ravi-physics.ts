/** Deterministic fixed-step physics; no DOM, clocks, random globals, RPC or money. */
export type Emotion = "idle" | "joy" | "sleepy" | "surprised" | "focused" | "thinking" | "working" | "sleep";
export type Bounds = { left: number; top: number; right: number; bottom: number };
export type Spring = { value: number; velocity: number; target: number };
export const spring = (value = 0): Spring => ({ value, velocity: 0, target: value });
export function integrate(s: Spring, dt: number, stiffness = 100, damping = 15) {
  s.velocity += ((s.target - s.value) * stiffness - damping * s.velocity) * dt;
  s.value += s.velocity * dt;
}
export const energy = (s: Spring, stiffness = 100) => .5 * s.velocity ** 2 + .5 * stiffness * (s.value - s.target) ** 2;
export function frameRate(active: boolean, battery: boolean, hidden: boolean): number {
  return hidden ? 0 : active ? battery ? 24 : 60 : 15;
}
const limit = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
export class RaviPhysics {
  x = 0; y = 0; vx = 0; vy = 0; time = 0; remainder = 0;
  offsetX = spring(); tilt = spring(); scale = spring(1); bounce = spring();
  resting: "idle" | "sleep" = "idle";
  emotion: Emotion = "sleep"; reduced = false; dragging = false;
  gazeX = 0; gazeY = 0; eye = 0; breath = 0; particles = 0;
  private entered = 0; private touched = 0; private blinkAt = 3; private blinkStart = -10;
  private seed: number;
  constructor(seed = 17) { this.seed = seed >>> 0; }
  private random() { this.seed = (1664525 * this.seed + 1013904223) >>> 0; return this.seed / 4294967296; }
  setEmotion(mode: Emotion) {
    if (this.emotion === mode) return;
    this.emotion = mode; this.entered = this.time;
    if (mode === "joy" && !this.reduced) this.bounce.velocity = -160;
    if (mode === "surprised" && !this.reduced) this.scale.velocity = 2;
  }
  touch() { this.touched = this.time; if (this.emotion === "sleepy") this.setEmotion("idle"); }
  beginDrag() { this.dragging = true; this.vx = this.vy = 0; this.touch(); }
  drag(x: number, y: number, dt: number, bounds: Bounds) {
    if (!this.dragging || !Number.isFinite(x+y+dt) || dt <= 0) return;
    const nx = limit(x,bounds.left,bounds.right), ny = limit(y,bounds.top,bounds.bottom);
    const alpha = 1 - Math.exp(-dt * 20);
    this.vx += (limit((nx-this.x)/dt,-1800,1800)-this.vx)*alpha;
    this.vy += (limit((ny-this.y)/dt,-1800,1800)-this.vy)*alpha;
    this.x = nx; this.y = ny;
    if (Math.hypot(this.vx,this.vy)>950) this.setEmotion("surprised");
  }
  release() { this.dragging = false; if (this.reduced) this.vx = this.vy = 0; this.scale.velocity = this.reduced ? 0 : -1.5; }
  arrive() { if (!this.reduced) { this.offsetX.value = -90; this.bounce.value = -55; this.tilt.value = -18; this.scale.value = .8; } }
  look(x: number, y: number) { this.gazeX = limit(x,-4,4); this.gazeY = limit(y,-3,3); }
  step(dt: number, bounds: Bounds, paused = false) {
    if (paused || !Number.isFinite(dt) || dt <= 0) return;
    this.remainder += Math.min(dt,.25);
    const h = 1/240;
    while (this.remainder + 1e-10 >= h) { this.tick(h,bounds); this.remainder -= h; }
  }
  private tick(h: number, b: Bounds) {
    this.time += h;
    if (!this.dragging) {
      const friction = Math.exp(-3.8*h);
      this.vx *= friction; this.vy *= friction;
      this.x += this.vx*h; this.y += this.vy*h;
      if (this.x<b.left || this.x>b.right) { this.x=limit(this.x,b.left,b.right); this.vx *= -.52; this.land(); }
      if (this.y<b.top || this.y>b.bottom) { this.y=limit(this.y,b.top,b.bottom); this.vy *= -.52; this.land(); }
      if (Math.hypot(this.vx,this.vy)<.4) this.vx=this.vy=0;
    }
    const age = this.time-this.entered;
    if (["joy","surprised"].includes(this.emotion) && age>1.8) this.setEmotion(this.resting);
    if (this.emotion === "idle" && this.time-this.touched>90) this.setEmotion("sleepy");
    if (this.time>=this.blinkAt) { this.blinkStart=this.time; this.blinkAt=this.time+3+this.random()*3; }
    const ba=this.time-this.blinkStart;
    const blink=ba>=0&&ba<.18?Math.sin(ba/.18*Math.PI):0;
    this.eye=this.emotion==="sleep"?0:(this.emotion==="sleepy"?.45:1)*(1-blink);
    this.breath=Math.sin(this.time*(this.emotion==="sleep"?.6:1.6))*(this.reduced?.002:.013);
    this.tilt.target=this.reduced?0:limit(this.vx*.012,-14,14)+(this.emotion==="focused"?-6:Math.sin(this.time*.6)*2);
    this.scale.target=1; this.bounce.target=0;
    if (this.reduced) { this.tilt.value=0; this.scale.value=1; this.bounce.value=0; this.offsetX.value=0; this.offsetX.velocity=0; this.tilt.velocity=this.scale.velocity=this.bounce.velocity=0; }
    else { integrate(this.offsetX,h,65,14); integrate(this.tilt,h); integrate(this.scale,h,130,14); integrate(this.bounce,h,110,12); }
    this.particles=this.emotion==="joy"&&!this.reduced?Math.min(12,Math.ceil((1-Math.min(1,age/1.8))*12)):0;
  }
  private land() { if (!this.reduced) this.scale.velocity=-Math.min(2.4,Math.hypot(this.vx,this.vy)/250+.5); }
  get active() { return this.dragging || Math.hypot(this.vx,this.vy)>0 || Math.abs(this.bounce.value)>.1 || Math.abs(this.scale.value-1)>.002 || ["joy","surprised","thinking","working"].includes(this.emotion) || this.emotion === "focused" && this.time-this.touched<1.4; }
}

/** All scheduling is owned here, so hiding cancels RAF AND the idle timeout. */
export function createFrameLoop(api: { now(): number; raf(cb: (time: number) => void): number; cancelRaf(id: number): void;
  delay(cb: () => void, ms: number): number; cancelDelay(id: number): void }, draw: (dt: number) => void, rate: () => number) {
  let running=false, frame=0, timer=0, last=0;
  const cancel=()=>{ api.cancelRaf(frame); api.cancelDelay(timer); frame=timer=0; };
  const schedule=()=>{
    const fps=rate(); if (!running || !fps) return;
    if (fps===60) frame=api.raf(tick);
    else timer=api.delay(()=>{ timer=0; if(running) frame=api.raf(tick); },1000/fps);
  };
  const tick=(now:number)=>{ frame=0; if(!running)return; draw(Math.min(.25,Math.max(0,(now-last)/1000))); last=now; schedule(); };
  return { start(){ if(running)return; running=true; last=api.now(); schedule(); }, stop(){ running=false; cancel(); }, get running(){return running;} };
}
