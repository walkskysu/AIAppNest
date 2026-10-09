import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { dirname, join, relative, sep, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Storage, DataPaths } from '@aiappnest/storage';
import { DomainError, id } from '@aiappnest/domain';
import { migrations } from '../../../packages/storage/src/migrations';
import { ENGINE_VERSION } from '../../../packages/pi-adapter/src/types';
import type { DataJob } from '../../../packages/contracts/src/data';
import { snapshotSchema } from '@aiappnest/contracts';
import { packageHash, readPackage } from './skill-validation';
import { readSession } from '../../../packages/pi-adapter/src/session-reader';

export const backupLimits={files:100000,bytes:20*1024**3,fileBytes:512*1024**2,manifestBytes:32*1024**2};
const entry=z.strictObject({path:z.string().min(1).max(2048),size:z.number().int().nonnegative(),hash:z.string().regex(/^[a-f0-9]{64}$/)});
const manifestSchema=z.strictObject({format:z.literal('aiappnest-directory-v1'),schema:z.number().int().positive(),runtime:z.object({node:z.string(),pi:z.string(),adapter:z.string(),extension:z.string(),session:z.number()}),createdAt:z.number(),includesRecycle:z.literal(true),excluded:z.array(z.string()),files:z.array(entry).max(backupLimits.files),sessions:z.array(z.strictObject({appId:z.uuid(),conversationId:z.uuid(),path:z.string()})).max(backupLimits.files)});
export type BackupManifest=z.infer<typeof manifestSchema>;
const invalid=()=>{throw new DomainError('INVALID_INPUT');};
function outside(root:string,path:string) {const rel=relative(root,path);return rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel);}
export function safeRelative(path:string):string {
  if(!path || path.includes('\\') || path.startsWith('/') || path.split('/').some(p=>!p || p==='.' || p==='..' || /[<>:"|?*\x00-\x1f]/.test(p) || /[ .]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) invalid();
  return path;
}
function allowed(path:string) {return path==='data/platform.db' || /^(apps|skills)\//.test(path) && !/^apps\/[^/]+\/conversations\/[^/]+\/agent(?:\/|$)/i.test(path);}
export function removeManaged(paths:DataPaths,path:string) {
  paths.assertManaged(path);if(path===paths.root) invalid();if(!existsSync(path)) return;
  const inspect=(p:string)=>{paths.assertManaged(p);const stat=lstatSync(p);if(stat.isDirectory()) for(const n of readdirSync(p)) inspect(join(p,n));else if(!stat.isFile() || stat.nlink!==1) invalid();};
  inspect(path);rmSync(path,{recursive:true,force:true});
}
export function durableJson(path:string,value:unknown) {
  const temp=path+'.tmp-'+randomUUID();const fd=openSync(temp,'wx',0o600);
  try {writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temp,path);
}
async function digest(path:string,signal?:AbortSignal) {
  const hash=createHash('sha256');for await(const chunk of createReadStream(path)){signal?.throwIfAborted();hash.update(chunk);}return hash.digest('hex');
}
async function copyVerified(source:DataPaths,destination:DataPaths,file:z.infer<typeof entry>,signal:AbortSignal) {
  const path=join(source.root,file.path);if(regular(source,path).size!==file.size)invalid();
  const target=join(destination.root,file.path);destination.ensureDirectory(dirname(target));
  const fd=openSync(target,'wx',0o600),hash=createHash('sha256');let bytes=0;
  try {
    for await(const chunk of createReadStream(path)) {
      signal.throwIfAborted();bytes+=chunk.length;if(bytes>file.size)invalid();
      hash.update(chunk);let offset=0;
      while(offset<chunk.length)offset+=writeSync(fd,chunk,offset,chunk.length-offset);
    }
    if(bytes!==file.size || hash.digest('hex')!==file.hash)invalid();fsyncSync(fd);
  }finally{closeSync(fd);}
}
function regular(paths:DataPaths,path:string,max=backupLimits.fileBytes) {
  paths.assertManaged(path);const s=lstatSync(path);if(!s.isFile() || s.nlink!==1 || s.size>max) invalid();return s;
}
function inventory(paths:DataPaths,base=''):string[] {
  const result:string[]=[];
  const walk=(rel:string)=>{
    const p=join(paths.root,rel);paths.assertManaged(p);
    for(const n of readdirSync(p)) {
      const r=rel?rel+'/'+n:n;safeRelative(r);const child=join(paths.root,r);paths.assertManaged(child);const s=lstatSync(child);
      if(s.isDirectory()) walk(r);else {regular(paths,child);result.push(r);if(result.length>backupLimits.files) invalid();}
    }
  };walk(base);return result;
}
/** Verify database references as well as the package's self-reported inventory. No code is executed. */
function verifyReferences(db:DatabaseSync,paths:DataPaths,manifest:BackupManifest) {
  if(db.prepare('SELECT 1 FROM provider_profiles WHERE secretRef IS NOT NULL LIMIT 1').get()
    || ['grants','policy_records','data_jobs'].some(table=>db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) invalid();
  const files=new Map(manifest.files.map(file=>[file.path,file]));
  const sessions=new Map<string,BackupManifest['sessions'][number]>();
  for(const session of manifest.sessions) {
    safeRelative(session.path);
    if(sessions.has(session.conversationId) || !session.path.startsWith(`apps/${session.appId}/conversations/${session.conversationId}/sessions/`) || !session.path.endsWith('.jsonl') || !files.has(session.path)) invalid();
    readSession(join(paths.root,session.path));sessions.set(session.conversationId,session);
  }
  for(const row of db.prepare('SELECT id,appId,piSessionFile FROM conversations').all()) {
    const session=sessions.get(String(row.id));
    if(row.piSessionFile===null ? !!session : !session || session.appId!==row.appId || !String(row.piSessionFile).replace(/\\/g,'/').endsWith('/'+session.path)) invalid();
    sessions.delete(String(row.id));
  }
  if(sessions.size) invalid();
  for(const table of ['attachments','artifacts']) for(const row of db.prepare(`SELECT * FROM ${table}`).all()) {
    const expected=`apps/${id(String(row.appId))}/conversations/${id(String(row.conversationId))}/${table}/${id(String(row.id))}`;
    const file=files.get(expected);
    if(row.relativePath!==expected || !file || file.hash!==row.hash || file.size!==row.size) invalid();
  }
  for(const row of db.prepare('SELECT * FROM skills').all()) {
    const expected=`skills/${id(String(row.id))}/${String(row.version)}`;safeRelative(expected);
    if(row.sourcePath!==expected || packageHash(readPackage(paths.skill(id<'skill'>(String(row.id)),String(row.version))))!==row.hash) invalid();
  }
  for(const row of db.prepare('SELECT r.id,r.appId,r.runtimeVersion,s.snapshot,s.configHash FROM app_revisions r LEFT JOIN revision_snapshots s ON s.revisionId=r.id').all()) {
    if(typeof row.snapshot!=='string') invalid();
    const snapshot=snapshotSchema.parse(JSON.parse(String(row.snapshot)));
    const base=`apps/${id(String(row.appId))}/revisions/${id(String(row.id))}`;
    if(snapshot.appId!==row.appId || snapshot.revisionId!==row.id || row.runtimeVersion!==ENGINE_VERSION.pi || snapshot.runtimeVersion!==ENGINE_VERSION.pi || files.get(base+'/manifest.json')?.hash!==row.configHash || readFileSync(join(paths.root,base,'manifest.json'),'utf8')!==row.snapshot) invalid();
    for(const resource of snapshot.resources) if(files.get(base+'/'+resource.path)?.hash!==resource.hash) invalid();
    for(const skill of snapshot.skills??[]) if(packageHash(readPackage(join(paths.root,base,safeRelative(skill.path))))!==skill.hash) invalid();
    for(const binding of snapshot.config.skills) if(db.prepare('SELECT hash FROM skills WHERE id=? AND version=?').get(binding.id,binding.version)?.hash!==binding.hash) invalid();
  }
}
export class BackupService {
  constructor(private storage:Storage,private fault:(point:string)=>void=()=>{}) {}
  async preflight(root:string,signal?:AbortSignal,limits=backupLimits):Promise<BackupManifest> {
    const paths=new DataPaths(root);regular(paths,join(root,'manifest.json'),limits.manifestBytes);
    const manifest=manifestSchema.parse(JSON.parse(readFileSync(join(root,'manifest.json'),'utf8')));
    // Directory package v1 was introduced with schema 11; older database files are not v1 packages.
    if(manifest.schema<11 || manifest.schema>migrations.length || Object.entries(ENGINE_VERSION).some(([key,value])=>manifest.runtime[key as keyof typeof ENGINE_VERSION]!==value)) invalid();
    if(manifest.files.length>limits.files) invalid();
    const names=new Set<string>();let total=0;
    for(const file of manifest.files) {
      signal?.throwIfAborted();safeRelative(file.path);if(!allowed(file.path) || names.has(file.path.toLowerCase())) invalid();names.add(file.path.toLowerCase());
      total+=file.size;if(total>limits.bytes || file.size>limits.fileBytes) invalid();
      const path=join(root,file.path),s=regular(paths,path,limits.fileBytes);if(s.size!==file.size || await digest(path,signal)!==file.hash) invalid();
    }
    if(!names.has('data/platform.db')) invalid();
    const actual=inventory(paths);if(actual.length!==names.size+1 || actual.some(p=>p!=='manifest.json' && !names.has(p.toLowerCase()))) invalid();
    const db=new DatabaseSync(join(root,'data/platform.db'),{readOnly:true});
    try {
      const applied=db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all();
      if(applied.length!==manifest.schema || applied.some((row,i)=>row.version!==migrations[i]?.version||row.name!==migrations[i]?.name||row.checksum!==createHash('sha256').update(migrations[i]!.sql).digest('hex')))invalid();
      if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)invalid();
      verifyReferences(db,paths,manifest);
    }finally{db.close();}
    return manifest;
  }
  async create(parent:string,job:DataJob,signal:AbortSignal,progress:()=>void) {
    const paths=new DataPaths(parent);paths.assertManaged(parent);
    // Never recursively include output in the source, nor publish over any existing directory.
    if(!outside(this.storage.paths.root,parent)) invalid();
    const temp=join(parent,'.incomplete-'+job.id),output=join(parent,job.id+'.aibackup');
    paths.ensureDirectory(temp);
    try {
      const target=new DataPaths(temp);target.ensureDirectory(join(temp,'data'));
      await this.storage.backupTo(join(temp,'data/platform.db'));signal.throwIfAborted();
      const db=new DatabaseSync(join(temp,'data/platform.db'));
      try {
        db.exec("UPDATE provider_profiles SET secretRef=NULL,revision=revision+1; DELETE FROM grants; DELETE FROM policy_records; DELETE FROM data_jobs; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; VACUUM;");
      } finally {db.close();}
      const sessions=this.storage.fileContainers().flatMap(c=>{
        const file=this.storage.conversations.get({appId:c.appId,id:c.conversationId}).piSessionFile;
        return file?[{appId:c.appId,conversationId:c.conversationId,path:safeRelative(relative(this.storage.paths.root,file).split(sep).join('/'))}]:[];
      });
      const manifest:BackupManifest={format:'aiappnest-directory-v1',schema:migrations.length,runtime:{...ENGINE_VERSION},createdAt:Date.now(),includesRecycle:true,
        excluded:['credentials/ (including machine-bound ciphertext)','agent/ runtime credentials, cache, logs, backups, incomplete jobs','external authorized directories (authorization must be granted again)'],files:[],sessions};
      const files=['data/platform.db'];
      for(const area of ['apps','skills']) if(existsSync(join(this.storage.paths.root,area))) {
        // Walk only approved areas; never even traverse agent credential homes.
        const walk=(rel:string)=>{for(const n of readdirSync(join(this.storage.paths.root,rel))){const r=rel+'/'+n;if(!allowed(r))continue;safeRelative(r);const p=join(this.storage.paths.root,r);this.storage.paths.assertManaged(p);const s=lstatSync(p);if(s.isDirectory())walk(r);else{regular(this.storage.paths,p);files.push(r);if(files.length>backupLimits.files)invalid();}}};walk(area);
      }
      let total=0;
      for(const path of files) {
        signal.throwIfAborted();const dest=join(temp,path);
        if(path!=='data/platform.db'){target.ensureDirectory(dirname(dest));await copyFile(join(this.storage.paths.root,path),dest);}
        const size=regular(target,dest).size;total+=size;if(total>backupLimits.bytes)invalid();
        manifest.files.push({path,size,hash:await digest(dest,signal)});job.files++;progress();this.fault('copy');
      }
      durableJson(join(temp,'manifest.json'),manifest);job.state='verifying';progress();await this.preflight(temp,signal);
      signal.throwIfAborted();this.fault('publish');paths.publishDirectory(temp,output);return output;
    } catch(error) {removeManaged(paths,temp);throw error;}
  }
  async restore(source:string,parent:string,job:DataJob,signal:AbortSignal,progress:()=>void) {
    if(!outside(this.storage.paths.root,parent)||!outside(source,parent))invalid();
    const manifest=await this.preflight(source,signal),parentPaths=new DataPaths(parent),temp=join(parent,'.restore-'+job.id),output=join(parent,'restored-'+job.id.slice(0,12));
    parentPaths.ensureDirectory(temp);
    try {
      const stage=new DataPaths(temp);let restored:Storage|undefined;
      for(const file of manifest.files){signal.throwIfAborted();await copyVerified(new DataPaths(source),stage,file,signal);job.files++;progress();}
      this.fault('migration');
      try {
        restored=new Storage(temp);
        // Revalidate database paths against the manifest before any file interpretation.
        for(const c of restored.fileContainers()) {
          const row=restored.conversations.get({appId:c.appId,id:c.conversationId}),matches=manifest.sessions.filter(s=>s.appId===c.appId && s.conversationId===c.conversationId);
          if(matches.length>1 || (row.piSessionFile!==null)!==(matches.length===1) || row.piSessionFile && !row.piSessionFile.replace(/\\/g,'/').endsWith('/'+matches[0]!.path)) invalid();
        }
        for(const file of restored.managedFiles()) {
          const area=file.kind==='artifact'?'artifacts':'attachments',expected=`apps/${id(String(file.appId))}/conversations/${id(String(file.conversationId))}/${area}/${id(String(file.id))}`;
          if(file.relativePath!==expected)invalid();
          const record=area==='artifacts'?restored.artifacts.get({appId:id<'app'>(String(file.appId)),id:id<'artifact'>(String(file.id))}):restored.attachments.get({appId:id<'app'>(String(file.appId)),id:id<'attachment'>(String(file.id))});
          if(!manifest.files.some(f=>f.path===expected&&f.size===record.size&&f.hash===record.hash))invalid();
        }
        for(const run of restored.unfinishedRuns()) restored.transitionRun(run.appId,run.id,run.version,run.state==='queued'?'cancelled':'interrupted',undefined,'RESTORED_REQUIRES_RETRY');
        restored.candidates.recover();restored.search.rebuild();
      } finally {restored?.close();}
      const db=new DatabaseSync(stage.database);
      try {
        db.exec('PRAGMA foreign_keys=ON');
        for(const session of manifest.sessions) {
          const path=join(temp,session.path),data=readFileSync(path,'utf8'),at=data.indexOf('\n');if(at<0)invalid();
          const header=JSON.parse(data.slice(0,at));if(header.type!=='session' || header.version!==ENGINE_VERSION.session)invalid();
          header.cwd=join(output,'apps',session.appId,'conversations',session.conversationId,'agent','cwd');
          writeFileSync(path,JSON.stringify(header)+data.slice(at));
          db.prepare('UPDATE conversations SET piSessionFile=? WHERE appId=? AND id=?').run(join(output,session.path),session.appId,session.conversationId);
        }
        db.exec("UPDATE provider_profiles SET secretRef=NULL,revision=revision+1; DELETE FROM grants; DELETE FROM policy_records; DELETE FROM data_jobs; UPDATE extraction_tasks SET state='cancelled',error='RESTORED_REQUIRES_RETRY',version=version+1 WHERE state IN ('pending','running');");
        if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok' || db.prepare('PRAGMA foreign_key_check').all().length)invalid();
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      }finally{db.close();}
      this.fault('restore-validated');signal.throwIfAborted();durableJson(join(temp,'restore-ready.json'),{jobId:job.id,root:output});
      parentPaths.publishDirectory(temp,output);return output;
    }catch(error){removeManaged(parentPaths,temp);throw error;}
  }
}
