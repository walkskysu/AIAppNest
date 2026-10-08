import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '@aiappnest/domain';

export const SEARCH_VERSION = 1;
// NFKC, case folding and punctuation/whitespace removal; originals remain authoritative.
export const normalizeSearch = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const encode = (s: string) => 'x' + Buffer.from(s).toString('hex');
export function searchTerms(value: string, singles = false): string[] {
  const chars = [...normalizeSearch(value)];
  return [...new Set(chars.flatMap((c,i) => [ ...(singles || chars.length === 1 ? [encode(c)] : []), ...(i ? [encode(chars[i-1]!+c)] : []) ]))];
}
export function registerSearchFunctions(db: DatabaseSync) {
  db.function('search_normalize', { deterministic:true }, v => normalizeSearch(String(v)));
  db.function('search_grams', { deterministic:true }, v => searchTerms(String(v),true).join(' '));
  let previousQuery='', wanted:string[]=[];
  db.function('search_score', { deterministic:true }, (grams,queryGrams) => {
    const query=String(queryGrams);
    if(query!==previousQuery) {previousQuery=query;wanted=query.split(' ').filter(Boolean).map(t=>' '+t+' ');}
    const indexed=' '+String(grams)+' ';
    return wanted.length ? wanted.filter(t=>indexed.includes(t)).length/wanted.length : 0;
  });
}
export interface SearchHit { id:string; kind:'memory'|'message'; conversationId:string|null; content:string; snippet:string; version:number; updatedAt:number }
export class SearchIndex {
  constructor(private readonly db: DatabaseSync, private readonly transaction: (fn:()=>void)=>void) {}
  rebuild(fault:()=>void = ()=>{}) {
    this.transaction(() => {
      this.db.exec('DELETE FROM search_documents');
      this.db.exec(`INSERT INTO search_documents(kind,id,appId,conversationId,version,content,normalized,grams,updatedAt,expiresAt)
        SELECT 'memory',m.id,m.appId,m.sourceConversationId,m.version,m.content,search_normalize(m.content),search_grams(m.content),m.updatedAt,m.expiresAt
        FROM memories m WHERE m.status='active' AND m.version=(SELECT max(version) FROM memories WHERE appId=m.appId AND id=m.id);
        INSERT INTO search_documents(kind,id,appId,conversationId,version,content,normalized,grams,updatedAt,expiresAt)
        SELECT 'message',m.id,m.appId,m.conversationId,1,m.content,search_normalize(m.content),search_grams(m.content),m.createdAt,NULL
        FROM messages m JOIN conversations c ON c.id=m.conversationId AND c.appId=m.appId
        WHERE m.status='complete' AND m.role IN ('user','assistant') AND c.status='active';`);
      fault();
      this.db.prepare('UPDATE search_meta SET version=?').run(SEARCH_VERSION);
    });
  }
  search(appId:string,query:string,kind:'memory'|'message',mode:'phrase'|'terms'|'fuzzy',limit:number,offset:number) {
    if (this.db.prepare('SELECT version FROM search_meta').get()?.version !== SEARCH_VERSION) throw new DomainError('STORAGE_UNAVAILABLE');
    const terms=mode==='terms' ? [...new Set((query.normalize('NFKC').match(/[\p{L}\p{N}]+/gu)??[]).flatMap(t=>searchTerms(t)))] : searchTerms(query), normalized=normalizeSearch(query);
    if (!terms.length) return { total:0,hits:[] as SearchHit[] };
    // Only generated hex tokens enter MATCH. All user/scoping values are bound.
    const match=terms.map(t=>'"'+t+'"').join(mode==='fuzzy' ? ' OR ' : ' AND ');
    const where=`d.appId=? AND d.kind=? AND search_fts MATCH ? AND (d.expiresAt IS NULL OR d.expiresAt>?)
      AND (d.kind='memory' OR EXISTS(SELECT 1 FROM conversations c WHERE c.appId=d.appId AND c.id=d.conversationId AND c.status='active'))
      ${mode==='phrase' ? 'AND instr(d.normalized,?)>0' : mode==='fuzzy' ? 'AND search_score(d.grams,?)>=0.5' : ''}`;
    const args=[appId,kind,match,Date.now(),...(mode==='phrase' ? [normalized] : mode==='fuzzy' ? [terms.join(' ')] : [])];
    const from=' FROM search_fts JOIN search_documents d ON d.rowid=search_fts.rowid WHERE '+where;
    const total=this.db.prepare('SELECT count(*) n'+from).get(...args)!.n as number;
    const rows=this.db.prepare('SELECT d.id,d.kind,d.conversationId,d.content,d.version,d.updatedAt'+from+' ORDER BY d.updatedAt DESC,d.id LIMIT ? OFFSET ?').all(...args,limit,offset);
    return { total,hits:rows.map(row=>{
      const content=row.content as string;
      // Locate in the original using a normalized-to-original offset map (NFKC can expand characters).
      let normalizedText='', positions:number[]=[];
      for (let i=0;i<content.length;) { const c=String.fromCodePoint(content.codePointAt(i)!); const n=normalizeSearch(c); normalizedText+=n; positions.push(...Array(n.length).fill(i)); i+=c.length; }
      let at=normalizedText.indexOf(normalized);
      if(at<0) at=normalizedText.indexOf([...normalized].slice(0,2).join(''));
      const start=Math.max(0,(positions[Math.max(0,at)] ?? 0)-35);
      return { ...row,snippet:(start ? '…':'')+content.slice(start,start+180)+(start+180<content.length ? '…':'') } as unknown as SearchHit;
    }) };
  }
}
