import { mountRaviRig } from "./ravi-rig";
import { openingFrame, OPENING_MS, REDUCED_OPENING_MS } from "./ravi-choreography";
import { createFrameLoop, frameRate } from "./ravi-physics";

/** Completion always paints the grounded pose BEFORE releasing the input barrier. */
export function mountRaviOpening(host: HTMLElement, landed: () => void) {
  const rig=mountRaviRig(host), reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let done=false, battery=false, saver=false;
  const start=performance.now(), duration=reduced.matches?REDUCED_OPENING_MS:OPENING_MS;
  const loop=createFrameLoop({now:()=>performance.now(),raf:requestAnimationFrame,cancelRaf:cancelAnimationFrame,
    delay:(f,ms)=>window.setTimeout(f,ms),cancelDelay:clearTimeout},()=>{
    const elapsed=performance.now()-start;
    if(elapsed>=duration)finish();else rig.renderFrame(openingFrame(elapsed,reduced.matches));
  },()=>frameRate(true,battery||saver,document.hidden));
  const finish=()=>{
    if(done)return;done=true;loop.stop();clearTimeout(fallback);
    rig.renderFrame(openingFrame(duration,reduced.matches));
    document.removeEventListener('visibilitychange',visibility);landed();
  };
  const visibility=()=>{loop.stop();if(!done&&!document.hidden)loop.start();};
  const fallback=window.setTimeout(finish,duration);
  rig.renderFrame(openingFrame(0,reduced.matches));loop.start();
  document.addEventListener('visibilitychange',visibility);
  type Battery={charging:boolean;addEventListener(name:string,fn:()=>void):void;removeEventListener(name:string,fn:()=>void):void};
  let pack:Battery|undefined;
  const charge=()=>{battery=pack?.charging===false;};
  void (navigator as Navigator & {getBattery?():Promise<Battery>}).getBattery?.().then(b=>{if(done)return;pack=b;charge();b.addEventListener('chargingchange',charge);}).catch(()=>{});
  return { finish, batterySaver(value:boolean){saver=value;}, destroy(){done=true;loop.stop();clearTimeout(fallback);rig.destroy();document.removeEventListener('visibilitychange',visibility);pack?.removeEventListener('chargingchange',charge);} };
}
