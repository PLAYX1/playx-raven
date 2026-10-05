import scene from "./assets/ravi-scene.svg?raw";

// Geometry, pivots and spring choreography ported from approved proto3/rig.js.
export type RaviMode = "sleep" | "idle" | "listening" | "thinking" | "speaking" | "joy";
export class RaviSpring {
  velocity = 0;
  target: number;
  constructor(public value: number, private stiffness = 120, private damping = 20) { this.target = value; }
  step(dt: number): void {
    for (let left = Math.min(dt, .05); left > 0;) {
      const h = Math.min(left, 1 / 120);
      this.velocity += ((this.target - this.value) * this.stiffness - this.velocity * this.damping) * h;
      this.value += this.velocity * h;
      left -= h;
    }
  }
  snap(): void { this.value = this.target; this.velocity = 0; }
}
export class RaviPose {
  mode: RaviMode = "sleep";
  phase = 0;
  level = 0;
  private blinkAt = 3;
  private blinkStart = -10;
  private tiltAt = 7;
  private tiltUntil = 0;
  private tailAt = 5;
  private tailUntil = 0;
  stretchUntil = 0;
  joyAt = -10;
  blink = 0;
  readonly springs = {
    head: new RaviSpring(6), lean: new RaviSpring(0), eye: new RaviSpring(0),
    lookX: new RaviSpring(0), lookY: new RaviSpring(0), up: new RaviSpring(0),
    wing: new RaviSpring(0), beak: new RaviSpring(0, 270, 22),
    feather: new RaviSpring(0), jump: new RaviSpring(0), tail: new RaviSpring(0),
  };
  constructor(private random: () => number = Math.random) {}
  setMode(mode: RaviMode): void {
    this.mode = mode;
    const p = this.springs;
    p.head.target = mode === "sleep" ? 6 : mode === "listening" ? -7 : mode === "thinking" ? -4 : 0;
    p.lean.target = mode === "listening" ? 1 : 0;
    p.up.target = mode === "thinking" ? -5 : 0;
    p.eye.target = mode === "sleep" ? 0 : mode === "listening" ? 1.1 : 1;
    if (mode !== "speaking") p.beak.target = 0;
    if (mode === "joy") this.joyAt = this.phase;
  }
  wake(): void { this.setMode("idle"); this.stretchUntil = this.phase + 1.7; }
  step(dt: number, reduced: boolean, paused: boolean): void {
    if (paused) return;
    this.phase += Math.min(dt, .05);
    const t = this.phase, p = this.springs;
    if (this.mode !== "sleep" && t >= this.blinkAt) {
      this.blinkStart = t; this.blinkAt = t + 3 + this.random() * 3;
    }
    this.blink = Math.sin(Math.max(0, 1 - (t - this.blinkStart) / .18) * Math.PI);
    if (reduced) { Object.values(p).forEach(s => s.snap()); return; }
    if (this.mode === "idle" && t > this.tiltAt) {
      p.head.target = (this.random() > .5 ? 1 : -1) * (3 + this.random() * 3);
      this.tiltUntil = t + 1.5; this.tiltAt = t + 7 + this.random() * 7;
    }
    if (this.tiltUntil && t > this.tiltUntil) { this.tiltUntil = 0; if (this.mode === "idle") p.head.target = 0; }
    if (t > this.tailAt) { p.tail.target = -10; this.tailUntil = t + .35; this.tailAt = t + 5 + this.random() * 8; }
    if (this.tailUntil && t > this.tailUntil) { this.tailUntil = 0; p.tail.target = 0; }
    p.wing.target = t < this.stretchUntil - .8 ? 42 : this.mode === "joy" ? 20 : 0;
    p.beak.target = this.mode === "speaking" ? Math.max(.03, this.level) * (.5 + .5 * Math.abs(Math.sin(t * 12))) : 0;
    p.feather.target = this.mode === "listening" ? Math.sin(t * 28) * this.level * 9 : Math.sin(t * 1.6) * 1.6;
    p.jump.target = this.mode === "joy" ? Math.max(0, Math.sin((t - this.joyAt) * 7)) * -15 : 0;
    Object.values(p).forEach(s => s.step(dt));
  }
}
let instance = 0;
export function mountRaviRig(host: HTMLElement) {
  // Every instance gets local SVG references, including the moving reflection.
  const prefix = `ravi-${++instance}-`;
  host.innerHTML = scene.replace(/\bid="([^"]+)"/g, `id="${prefix}$1"`)
    .replace(/url\(#([^)]*)\)/g, `url(#${prefix}$1)`)
    .replace(/href="#([^"]+)"/g, `href="#${prefix}$1"`);
  const svg = host.querySelector("svg")!;
  svg.setAttribute("aria-hidden", "true");
  svg.removeAttribute("aria-label");
  const parts = new Map<string, SVGElement>();
  host.querySelectorAll<SVGElement>("[id]").forEach(el => parts.set(el.id.slice(prefix.length), el));
  const transform = (name: string, value: string) => parts.get(name)?.setAttribute("transform", value);
  const opacity = (name: string, value: number) => parts.get(name)?.setAttribute("opacity", String(value));
  const pose = new RaviPose();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let paused = true, frame = 0, last = 0;
  function draw() {
    const t = pose.phase, motion = reduced.matches ? 0 : 1;
    const p = Object.fromEntries(Object.entries(pose.springs).map(([k, s]) => [k, s.value]));
    const sleep = pose.mode === "sleep", speak = pose.mode === "speaking";
    const breath = motion * Math.sin(t * (sleep ? .5 : 1.55)) * (sleep ? .009 : .014);
    transform("ravi-character", `translate(0 ${p.jump * motion})`);
    transform("rig-body", `translate(0 ${-breath * 65}) translate(180 350) rotate(${-p.lean * 1.5 * motion}) scale(${1 + breath}) translate(-180 -350)`);
    transform("rig-head", `translate(0 ${sleep ? 5 : 0}) rotate(${p.head} 180 254) translate(180 254) scale(${1 + p.lean * .018}) translate(-180 -254)`);
    transform("rig-feathers", `rotate(${p.feather * motion} 139 102)`);
    transform("rig-ribbon", `rotate(${Math.sin(t * 1.2) * 1.2 * motion} 90 156)`);
    transform("rig-tail", `rotate(${p.tail * motion} 108 324)`);
    const wing = motion * (p.wing + (speak ? Math.sin(t * 3) * pose.level * 8 : 0));
    transform("rig-wing-left", `rotate(${wing} 122 266)`);
    transform("rig-wing-right", `rotate(${-wing} 237 264)`);
    const open = Math.max(0, Math.min(1.12, p.eye)) * (1 - pose.blink);
    for (const side of ["left", "right"]) {
      const cx = side === "left" ? 148 : 238, cy = side === "left" ? 204 : 197;
      transform(`eye-open-${side}`, `translate(${cx} ${cy}) scale(1 ${Math.max(.015, open)}) translate(${-cx} ${-cy})`);
      opacity(`rig-lid-${side}`, Math.max(0, 1 - Math.min(1, open) * 1.1));
      transform(`rig-pupil-${side}`, `translate(${p.lookX * motion} ${(p.lookY + p.up) * motion})`);
      opacity(`rig-star-${side}`, reduced.matches ? 1 : t < pose.stretchUntil ? .7 + .3 * Math.sin(t * 18) : .85 + .15 * Math.sin(t * 2));
    }
    transform("rig-beak-upper", `rotate(${-p.beak * 5 * motion} 176 235)`);
    transform("rig-beak-lower", `translate(0 ${p.beak * 8 * motion}) rotate(${p.beak * 5 * motion} 178 244)`);
    opacity("sleep-particles", sleep && motion ? 1 : 0);
    transform("sleep-z", `translate(0 ${-((t * .18) % 1) * 16 * motion})`);
    opacity("thought-particles", pose.mode === "thinking" && motion ? 1 : 0);
    transform("thought-particles", `rotate(${t * 45 * motion} 228 64)`);
    opacity("joy-particles", pose.mode === "joy" && motion ? Math.max(0, 1 - (t - pose.joyAt) / 1.7) : 0);
    transform("joy-particles", `translate(180 275) scale(${1 + Math.max(0, t - pose.joyAt) * .2 * motion}) translate(-180 -275)`);
    transform("lake-mesh", `translate(0 ${Math.sin(t * .7) * 1.2 * motion})`);
    opacity("lake-ripple", reduced.matches ? .5 : .45 + .25 * Math.sin(t));
  }
  function tick(now: number) {
    if (paused) return;
    pose.step(last ? (now - last) / 1000 : 0, reduced.matches, false);
    last = now; draw(); frame = requestAnimationFrame(tick);
  }
  const pointer = (e: PointerEvent) => {
    if (paused || reduced.matches) return;
    const r = host.getBoundingClientRect();
    pose.springs.lookX.target = Math.max(-4, Math.min(4, (e.clientX - r.left - r.width * .5) / Math.max(1, r.width) * 8));
    pose.springs.lookY.target = Math.max(-3, Math.min(3, (e.clientY - r.top - r.height * .4) / Math.max(1, r.height) * 7));
  };
  const leave = () => { pose.springs.lookX.target = pose.springs.lookY.target = 0; };
  document.addEventListener("pointermove", pointer, { passive: true });
  document.addEventListener("pointerleave", leave);
  draw();
  return {
    pose,
    mode(mode: RaviMode) { pose.setMode(mode); if (reduced.matches) pose.step(0, true, false); if (!paused) draw(); },
    wake() { pose.wake(); },
    pause(value: boolean) {
      if (value === paused) return;
      paused = value; cancelAnimationFrame(frame); last = 0;
      if (!paused) frame = requestAnimationFrame(tick);
    },
    destroy() { paused = true; cancelAnimationFrame(frame); document.removeEventListener("pointermove", pointer); document.removeEventListener("pointerleave", leave); },
  };
}
