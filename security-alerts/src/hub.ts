import { DurableObject } from 'cloudflare:workers';
import { HOSTS, MINUTE } from './types';
import type { Alert, AlertKind, App, Control, DeliveryResult, Env } from './types';
import { appEvent } from './validation';
import { analyticsDiagnostic, pollWaf } from './analytics';
const MAX_SEEN=1792, MAX_CRITICAL_SEEN=128, MAX_LOCKED_SEEN=128, MAX_BUCKETS=256, MAX_QUEUE=128, MAX_DAY=200;
type Priority='regular'|'critical'|'locked'|'pipeline';
const LIMITS={regular:{pending:96,day:160},critical:{pending:16,day:20},locked:{pending:8,day:10},pipeline:{pending:8,day:10}};
const FIVE=5*MINUTE, HOUR=60*MINUTE, DAY=24*HOUR;
interface BucketRow { key:string; start:number; count:number; last_alert:number }
interface QueueRow { id:string; alert:string; attempts:number; next:number; lease_until:number; lease_token:string|null; created:number; priority:Priority }
const empty = (now:number):Control => ({enabled:false,generation:0,lastAlarm:null,active:null,seenCount:0,criticalSeenCount:0,lockedSeenCount:0,bucketCount:0,pending:0,saturationUntil:0,quota:{regular:{pending:0,day:0},critical:{pending:0,day:0},locked:{pending:0,day:0},pipeline:{pending:0,day:0}},
  sent:0,dead:0,deadAcknowledged:0,deadAcknowledgedAt:null,rejected:0,saturated:false,day:Math.floor(now/DAY),queuedToday:0,suppressed:0,
  analytics:{cursor:null,lastSuccess:null,nextTry:0,status:'unknown',code:'not_started',sampled:true,diagnostic:null}});
export class SecurityHub extends DurableObject<Env> {
  constructor(ctx:DurableObjectState,env:Env) {
    super(ctx,env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS control (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, expires INTEGER NOT NULL,priority TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS seen_expiry ON seen(expires);
      CREATE TABLE IF NOT EXISTS buckets (key TEXT PRIMARY KEY,start INTEGER NOT NULL,count INTEGER NOT NULL,last_alert INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS bucket_age ON buckets(updated);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY,alert TEXT NOT NULL,attempts INTEGER NOT NULL,next INTEGER NOT NULL,
        lease_until INTEGER NOT NULL,lease_token TEXT,created INTEGER NOT NULL,priority TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outbox_due ON outbox(next,lease_until);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY,status TEXT NOT NULL,at INTEGER NOT NULL,alert TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS receipt_age ON receipts(at);`);
    ctx.storage.sql.exec('INSERT OR IGNORE INTO control(id,value) VALUES(1,?)',JSON.stringify(empty(Date.now())));
  }
  private control():Control {return JSON.parse(this.ctx.storage.sql.exec<{value:string}>('SELECT value FROM control WHERE id=1').one().value);}
  private save(c:Control) {this.ctx.storage.sql.exec('UPDATE control SET value=? WHERE id=1',JSON.stringify(c));}
  private rows<T>(query:string,...args:(string|number|null)[]):T[] {return this.ctx.storage.sql.exec(query,...args).toArray() as unknown as T[];}
  private day(c:Control,now:number) {const day=Math.floor(now/DAY);if(c.day!==day){c.day=day;c.queuedToday=0;for(const quota of Object.values(c.quota))quota.day=0;}}
  private saturation(c:Control,now:number) {
    c.saturated=true;c.saturationUntil=now+15*MINUTE;c.suppressed++;
    const row=this.rows<BucketRow>('SELECT key,start,count,last_alert FROM buckets WHERE key=?','pipeline:queue_capacity')[0];
    if(row && now-row.last_alert<15*MINUTE)return;
    if(this.enqueue(c,{source:'pipeline',kind:'pipeline_degraded',severity:'warning',occurredAt:now,windowStart:now,windowEnd:now,count:1,detailCode:'queue_capacity'},'pipeline')) {
      this.ctx.storage.sql.exec(`INSERT INTO buckets(key,start,count,last_alert,updated) VALUES('pipeline:queue_capacity',?,1,?,?)
        ON CONFLICT(key) DO UPDATE SET last_alert=excluded.last_alert,updated=excluded.updated`,now,now,now);
    }
  }
  private enqueue(c:Control,alert:Omit<Alert,'version'|'id'>,priority:Priority=alert.source==='pipeline'?'pipeline':alert.severity==='critical'?'critical':alert.kind==='account_locked'?'locked':'regular'):boolean {
    this.day(c,Date.now());const quota=c.quota[priority],limit=LIMITS[priority];
    if(c.pending>=MAX_QUEUE||c.queuedToday>=MAX_DAY||quota.pending>=limit.pending||quota.day>=limit.day){
      if(priority!=='pipeline')this.saturation(c,Date.now());else{c.saturated=true;c.saturationUntil=Date.now()+15*MINUTE;c.suppressed++;}return false;
    }
    const full:Alert={version:1,id:crypto.randomUUID(),...alert};
    this.ctx.storage.sql.exec('INSERT INTO outbox(id,alert,attempts,next,lease_until,lease_token,created,priority) VALUES(?,?,0,?,0,NULL,?,?)',full.id,JSON.stringify(full),Date.now(),Date.now(),priority);
    c.pending++;c.queuedToday++;quota.pending++;quota.day++;return true;
  }
  private bump(c:Control,key:string,count:number,threshold:number,now:number,alert:Omit<Alert,'version'|'id'|'count'|'windowStart'|'windowEnd'>,allowAlert=true,windowStart?:number):boolean {
    let row=this.rows<BucketRow>('SELECT key,start,count,last_alert FROM buckets WHERE key=?',key)[0];
    if(!row){if(key.startsWith('subject:') && c.bucketCount>=MAX_BUCKETS){this.saturation(c,now);return false;}row={key,start:windowStart??now,count:0,last_alert:0};if(key.startsWith('subject:'))c.bucketCount++;}
    if(now-row.start>=FIVE){row.start=windowStart??now;row.count=0;}
    row.count=Math.min(1_000_000_000,row.count+count);
    let queued=false;
    if(allowAlert&&row.count>=threshold&&now-row.last_alert>=15*MINUTE){
      queued=this.enqueue(c,{...alert,count:row.count,windowStart:row.start,windowEnd:now});
      if(queued)row.last_alert=now;
    }
    this.ctx.storage.sql.exec(`INSERT INTO buckets(key,start,count,last_alert,updated) VALUES(?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET start=excluded.start,count=excluded.count,last_alert=excluded.last_alert,updated=excluded.updated`,key,row.start,row.count,row.last_alert,now);
    return queued;
  }
  async recordApp(source:App,input:unknown):Promise<{accepted:boolean;duplicate?:boolean;reason?:'invalid'|'capacity'}> {
    const now=Date.now(),event=appEvent(input,now);
    if(!event||!['core','portal'].includes(source))return {accepted:false,reason:'invalid'};
    return this.ctx.storage.transactionSync(()=>{
      const c=this.control(),id=`${source}:${event.eventId}`;
      if(this.rows<{id:string}>('SELECT id FROM seen WHERE id=?',id).length)return {accepted:true,duplicate:true};
      const priority=event.kind==='admin_privilege_changed'||event.kind==='totp_disabled'||event.kind==='security_policy_weakened'?'critical':event.kind==='account_locked'?'locked':'regular';
      if(priority==='critical'?c.criticalSeenCount>=MAX_CRITICAL_SEEN:priority==='locked'?c.lockedSeenCount>=MAX_LOCKED_SEEN:c.seenCount>=MAX_SEEN){c.rejected++;this.saturation(c,now);this.save(c);return {accepted:false,reason:'capacity'};}
      this.ctx.storage.sql.exec('INSERT INTO seen(id,expires,priority) VALUES(?,?,?)',id,now+15*MINUTE,priority);if(priority==='critical')c.criticalSeenCount++;else if(priority==='locked')c.lockedSeenCount++;else c.seenCount++;
      const kind:AlertKind=event.kind==='auth_failure'?'auth_failure_burst':event.kind==='auth_rate_limited'?'auth_rate_limited_burst':event.kind==='authorization_denied'?'authorization_denied_burst':event.kind;
      const sensitive=event.kind==='admin_privilege_changed'||event.kind==='totp_disabled'||event.kind==='security_policy_weakened';
      const base={source,kind,severity:sensitive?'critical' as const:'warning' as const,occurredAt:event.occurredAt,
        host:source==='core'?HOSTS[0]:HOSTS[1],...(event.reason?{detailCode:event.reason}:{})};
      const subject=event.actorHash??event.networkHash;
      if(sensitive||event.kind==='account_locked'){this.enqueue(c,{...base,count:1,windowStart:event.occurredAt,windowEnd:event.occurredAt,...(subject?{subjectHash:subject}:{})});this.save(c);return {accepted:true};}
      const threshold=event.kind==='auth_failure'?5:event.kind==='auth_rate_limited'||event.kind==='authorization_denied'?10:1;
      // Fixed global keys are processed first, so distributed spray remains observable at subject-cardinality saturation.
      const globalThreshold=event.kind==='auth_failure'?20:event.kind==='auth_rate_limited'||event.kind==='authorization_denied'?50:1;
      const globalQueued=this.bump(c,`global:${source}:${event.kind}`,1,globalThreshold,now,base,threshold>1||!subject);
      if(subject)this.bump(c,`subject:${source}:${event.kind}:${subject}`,1,threshold,now,{...base,subjectHash:subject},!globalQueued);
      this.save(c);return {accepted:true};
    });
  }
  async start() {
    return this.ctx.storage.transactionSync(()=>{
      const c=this.control();
      if(!c.enabled){c.enabled=true;c.generation++;c.active=null;this.save(c);this.ctx.storage.setAlarm(Date.now()+1000);}
      return {enabled:c.enabled,generation:c.generation};
    });
  }
  async stop() {
    return this.ctx.storage.transactionSync(()=>{const c=this.control();c.enabled=false;c.generation++;c.active=null;this.save(c);this.ctx.storage.deleteAlarm();return {enabled:false,generation:c.generation};});
  }
  async acknowledge() {
    return this.ctx.storage.transactionSync(()=>{
      const c=this.control(),now=Date.now();
      const leased=this.rows<{id:string}>('SELECT id FROM outbox WHERE lease_until>? LIMIT 1',now).length>0;
      if(c.pending!==0||leased||c.active!==null||c.analytics.status!=='ok'||c.analytics.lastSuccess===null||now-c.analytics.lastSuccess>5*MINUTE)return {acknowledged:false,reason:'not_ready'};
      c.deadAcknowledged=c.dead;c.deadAcknowledgedAt=now;this.save(c);return {acknowledged:true,deadAcknowledged:c.deadAcknowledged,at:now};
    });
  }
  async status() {
    const c=this.control(),now=Date.now();
    return {service:'helth-security',enabled:c.enabled,generation:c.generation,
      readiness:!c.enabled||c.saturated||c.dead>c.deadAcknowledged||c.analytics.status!=='ok'||c.analytics.lastSuccess===null||now-c.analytics.lastSuccess>5*MINUTE?'unknown':'operational',
      lastAlarm:c.lastAlarm,pending:c.pending,sent:c.sent,dead:c.dead,unacknowledgedDead:c.dead-c.deadAcknowledged,deadAcknowledgedAt:c.deadAcknowledgedAt,rejected:c.rejected,saturated:c.saturated,
      alertsQueuedToday:c.queuedToday,alertsSuppressed:c.suppressed,analytics:c.analytics,quota:c.quota,
      limits:{seen:MAX_SEEN,criticalSeen:MAX_CRITICAL_SEEN,lockedSeen:MAX_LOCKED_SEEN,subjectBuckets:MAX_BUCKETS,outbox:MAX_QUEUE,alertsPerUtcDay:MAX_DAY},
      recentDead:this.rows<{alert:string;at:number}>("SELECT alert,at FROM receipts WHERE status='dead' ORDER BY at DESC LIMIT 10").map(row=>({at:row.at,alert:JSON.parse(row.alert)})),
      nextAlarm:await this.ctx.storage.getAlarm()};
  }
  private prune(c:Control,now:number) {
    this.ctx.storage.sql.exec('DELETE FROM seen WHERE expires<=?',now);
    this.ctx.storage.sql.exec("DELETE FROM buckets WHERE updated<? AND key NOT LIKE 'global:%'",now-HOUR);
    this.ctx.storage.sql.exec('DELETE FROM receipts WHERE at<?',now-7*DAY);
    // Receipts are bounded independently from time under high traffic.
    this.ctx.storage.sql.exec('DELETE FROM receipts WHERE id IN (SELECT id FROM receipts ORDER BY at DESC LIMIT -1 OFFSET 1600)');
    c.seenCount=this.ctx.storage.sql.exec<{n:number}>("SELECT count(*) AS n FROM seen WHERE priority='regular'").one().n;
    c.criticalSeenCount=this.ctx.storage.sql.exec<{n:number}>("SELECT count(*) AS n FROM seen WHERE priority='critical'").one().n;
    c.lockedSeenCount=this.ctx.storage.sql.exec<{n:number}>("SELECT count(*) AS n FROM seen WHERE priority='locked'").one().n;
    c.bucketCount=this.ctx.storage.sql.exec<{n:number}>("SELECT count(*) AS n FROM buckets WHERE key LIKE 'subject:%'").one().n;
    if(now>=c.saturationUntil && c.seenCount<MAX_SEEN && c.criticalSeenCount<MAX_CRITICAL_SEEN && c.lockedSeenCount<MAX_LOCKED_SEEN && Object.entries(c.quota).every(([p,q])=>q.pending<LIMITS[p as Priority].pending&&q.day<LIMITS[p as Priority].day))c.saturated=false;
    this.day(c,now);
  }
  private degraded(c:Control,code:'analytics_unavailable'|'analytics_gap',now:number) {
    c.analytics.status='unknown';c.analytics.code=code;
    this.bump(c,`pipeline:${code}`,1,1,now,{source:'pipeline',kind:'pipeline_degraded',severity:'warning',occurredAt:now,detailCode:code});
  }
  private async analytics(token:string,generation:number) {
    const now=Date.now(),end=Math.floor((now-90_000)/MINUTE)*MINUTE;
    const query=this.ctx.storage.transactionSync(()=>{
      const c=this.control();if(!c.enabled||c.generation!==generation||c.active?.token!==token||c.analytics.nextTry>now)return null;
      let start=c.analytics.cursor??end-MINUTE;
      if(start<end-15*MINUTE){this.degraded(c,'analytics_gap',now);start=end-15*MINUTE;c.analytics.cursor=start;}
      this.save(c);if(start>=end)return null;return {start,end:Math.min(end,start+FIVE)};
    });
    if(!query)return;
    try {
      const groups=await pollWaf(this.env,query.start,query.end);
      this.ctx.storage.transactionSync(()=>{
        const c=this.control();if(!c.enabled||c.generation!==generation||c.active?.token!==token)return;
        for(const group of groups){
          const key=`waf:${group.host}:${group.action}`;
          this.bump(c,key,group.count,1,query.end,{source:'waf',kind:'waf_activity',severity:'warning',occurredAt:Date.now(),host:group.host,action:group.action,detailCode:'sampled_waf',...(group.ruleId?{ruleId:group.ruleId}:{})},true,query.start);
        }
        c.analytics.cursor=query.end;c.analytics.lastSuccess=Date.now();c.analytics.nextTry=0;c.analytics.diagnostic=null;
        c.analytics.status=query.end>=end?'ok':'unknown';c.analytics.code=query.end>=end?null:'analytics_gap';this.save(c);
      });
    } catch(error) {
      this.ctx.storage.transactionSync(()=>{
        const c=this.control();if(!c.enabled||c.generation!==generation||c.active?.token!==token)return;
        const code=error instanceof Error&&error.message==='analytics_gap'?'analytics_gap':'analytics_unavailable';
        this.degraded(c,code,Date.now());c.analytics.diagnostic={...analyticsDiagnostic(error),at:Date.now()};c.analytics.nextTry=Date.now()+5*MINUTE;this.save(c);
      });
    }
  }
  private async deliver(token:string,generation:number) {
    // At most four sends per alarm. Stable alert.id is reused across retries by the Slack bridge.
    for(let i=0;i<4;i++){
      const now=Date.now(),claimed=this.ctx.storage.transactionSync(()=>{
        const c=this.control();if(!c.enabled||c.generation!==generation||c.active?.token!==token)return null;
        const row=this.rows<QueueRow>("SELECT * FROM outbox WHERE next<=? AND lease_until<=? ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'pipeline' THEN 1 WHEN 'locked' THEN 2 ELSE 3 END,created LIMIT 1",now,now)[0];
        if(!row)return null;
        const leaseToken=crypto.randomUUID();this.ctx.storage.sql.exec('UPDATE outbox SET lease_until=?,lease_token=? WHERE id=?',now+30_000,leaseToken,row.id);return {row,token:leaseToken};
      });
      if(!claimed)return;
      let result:DeliveryResult={ok:false,code:'not_configured'};let timer:ReturnType<typeof setTimeout>|undefined;
      try {
        if(this.env.SLACK_NOTIFIER){
          const deadline=performance.now()+8000;
          result=await Promise.race([this.env.SLACK_NOTIFIER.sendSecurityAlert(JSON.parse(claimed.row.alert)),
            new Promise<DeliveryResult>(resolve=>{timer=setTimeout(()=>resolve({ok:false,code:'timeout'}),8000);})]);
          if(performance.now()>=deadline)result={ok:false,code:'timeout'};
        }
      } catch {result={ok:false,code:'network_error'};} finally {if(timer!==undefined)clearTimeout(timer);}
      this.ctx.storage.transactionSync(()=>{
        const row=this.rows<QueueRow>('SELECT * FROM outbox WHERE id=?',claimed.row.id)[0];
        if(!row||row.lease_token!==claimed.token)return;
        const c=this.control(),at=Date.now();
        if(result?.ok===true){this.ctx.storage.sql.exec('DELETE FROM outbox WHERE id=?',row.id);this.ctx.storage.sql.exec('INSERT OR REPLACE INTO receipts(id,status,at,alert) VALUES(?,?,?,?)',row.id,'sent',at,row.alert);c.pending--;c.quota[row.priority].pending--;c.sent++;}
        else {
          const attempts=row.attempts+1;
          if(at-row.created>=DAY||attempts>=8||result?.code==='invalid_alert'){
            this.ctx.storage.sql.exec('DELETE FROM outbox WHERE id=?',row.id);this.ctx.storage.sql.exec('INSERT OR REPLACE INTO receipts(id,status,at,alert) VALUES(?,?,?,?)',row.id,'dead',at,row.alert);c.pending--;c.quota[row.priority].pending--;c.dead++;
            if(row.priority!=='pipeline')this.bump(c,'pipeline:delivery_failed',1,1,at,{source:'pipeline',kind:'pipeline_degraded',severity:'warning',occurredAt:at,detailCode:'delivery_failed'});
          }else{
            const requested=typeof result?.retryAfterMs==='number'&&Number.isFinite(result.retryAfterMs)?result.retryAfterMs:0;
            const delay=Math.min(HOUR,Math.max(MINUTE,Math.min(HOUR,requested),MINUTE*2**Math.min(attempts-1,6)));
            this.ctx.storage.sql.exec('UPDATE outbox SET attempts=?,next=?,lease_until=0,lease_token=NULL WHERE id=?',attempts,at+delay,row.id);
          }
        }
        this.save(c);
      });
    }
  }
  async alarm() {
    const now=Date.now(),claim=this.ctx.storage.transactionSync(()=>{
      const c=this.control();if(!c.enabled)return null;
      // Reserve successor before external I/O. No catch-up burst and no fake successful slots.
      this.ctx.storage.setAlarm(now+MINUTE);
      if(c.active&&c.active.until>now)return null;
      const token=crypto.randomUUID();c.active={token,until:now+45_000,generation:c.generation};c.lastAlarm=now;this.prune(c,now);this.save(c);return {token,generation:c.generation};
    });
    if(!claim)return;
    try {await this.analytics(claim.token,claim.generation);await this.deliver(claim.token,claim.generation);}
    finally {this.ctx.storage.transactionSync(()=>{const c=this.control();if(c.active?.token===claim.token){c.active=null;this.save(c);}});}
  }
}
