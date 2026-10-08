import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { ProviderRuntime } from './runtime';

/** A dedicated, tool-free, memory-bounded worker. Errors and SDK output never enter diagnostics. */
export function extractRuntime(runtime:ProviderRuntime,input:{system:string;text:string;maxTokens:number},signal:AbortSignal,
  workerPath=join(__dirname,'provider-probe.cjs')):Promise<string> {
  return new Promise((resolve,reject)=>{
    if(signal.aborted) {reject(new Error('EXTRACTION_FAILED'));return;}
    const worker=new Worker(workerPath,{workerData:{...runtime,timeoutMs:Math.min(runtime.timeoutMs,30000),extraction:input},env:runtime.env,stdout:true,stderr:true,resourceLimits:{maxOldGenerationSizeMb:64}});
    worker.stdout.resume();worker.stderr.resume();
    let settled=false;
    const finish=(text?:string)=>{
      if(settled) return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);
      void worker.terminate().finally(()=>{if(text!==undefined) resolve(text);else reject(new Error('EXTRACTION_FAILED'));});
    };
    const abort=()=>finish(),timer=setTimeout(abort,Math.min(runtime.timeoutMs,30000));
    signal.addEventListener('abort',abort,{once:true});
    worker.once('message',raw=>finish(raw?.ok===true && typeof raw.text==='string' && Buffer.byteLength(raw.text)<=8192 ? raw.text : undefined));
    worker.once('error',abort);worker.once('exit',abort);
  });
}
