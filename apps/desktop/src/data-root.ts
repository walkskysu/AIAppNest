import { existsSync, lstatSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

function unlinked(path:string) {
  if(!isAbsolute(path) || /^[/\\]{2}/.test(path))throw new Error('INVALID_ROOT');
  let current=parse(path).root;for(const part of path.slice(current.length).split(sep)){current=join(current,part);if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error('LINKED_ROOT');}
}
function complete(root:string) {
  try {
    unlinked(root);const marker=join(root,'restore-ready.json'),db=join(root,'data/platform.db');unlinked(marker);unlinked(db);
    return existsSync(db)&&lstatSync(db).isFile()&&lstatSync(db).nlink===1&&existsSync(marker)&&JSON.parse(readFileSync(marker,'utf8')).root===root;
  }catch{return false;}
}
/** One atomic pointer; an interrupted temporary write is ignored. Never combine roots. */
export function selectedDataRoot(profile:string,fallback:string):string {
  const file=join(profile,'data-root.json');unlinked(file);if(!existsSync(file))return fallback;
  const value=JSON.parse(readFileSync(file,'utf8'));
  if(value.version!==1 || typeof value.active!=='string' || typeof value.previous!=='string')throw new Error('INVALID_ROOT_POINTER');
  // An upgrade exchange may temporarily remove the active directory. Let the leased
  // Service Host recover its journal before considering the old restore fallback.
  unlinked(value.active);unlinked(value.active+'.upgrade.json');
  if(existsSync(value.active+'.upgrade.json'))return value.active;
  if(complete(value.active))return value.active;
  unlinked(value.previous);const previousDb=join(value.previous,'data/platform.db');unlinked(previousDb);
  if(existsSync(previousDb)&&lstatSync(previousDb).isFile()&&lstatSync(previousDb).nlink===1)return value.previous;
  throw new Error('NO_COMPLETE_ROOT');
}
export function switchDataRoot(profile:string,previous:string,next:string,fault:()=>void=()=>{}) {
  if(resolve(next)===resolve(previous)||!complete(next))throw new Error('INVALID_ROOT');
  const file=join(profile,'data-root.json');unlinked(file);
  const temp=file+'.tmp-'+randomUUID(),fd=openSync(temp,'wx',0o600);
  try{writeFileSync(fd,JSON.stringify({version:1,active:next,previous}));fsyncSync(fd);}finally{closeSync(fd);}
  fault();renameSync(temp,file);
}
