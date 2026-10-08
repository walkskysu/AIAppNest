/** Timer budget excludes a detected long event-loop suspension. No operation is retried.
 * A wake is an observation to re-query state, never evidence of failure or completion. */
export function activeTimeout(action: () => void,ms: number,onWake: () => void = () => {}): NodeJS.Timeout {
  let remaining=ms,last=Date.now();
  const timer=setInterval(()=>{
    const now=Date.now(),gap=now-last;last=now;
    if (gap>5000) { onWake();return; }
    remaining-=Math.max(0,gap);
    if (remaining<=0) { clearInterval(timer);action(); }
  },Math.max(1,Math.min(ms,1000)));
  return timer;
}
