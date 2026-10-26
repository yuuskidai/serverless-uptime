import { HOSTS, ZONE_ID } from './types';
import type { AnalyticsDiagnosticCode, Env, WafGroup, WafRead } from './types';
import { boundedJSON, object } from './validation';
const actions = ['block', 'managed_challenge', 'js_challenge', 'challenge', 'log'] as const;

class AnalyticsFailure extends Error {
  constructor(readonly diagnosticCode: AnalyticsDiagnosticCode, readonly httpStatus: number | null = null) {
    // The Slack/outbox protocol deliberately retains its existing two coarse codes.
    super(diagnosticCode === 'result_truncated' ? 'analytics_gap' : 'analytics_unavailable');
  }
}
export function analyticsDiagnostic(error: unknown): {code:AnalyticsDiagnosticCode;httpStatus:number|null} {
  return error instanceof AnalyticsFailure ? {code:error.diagnosticCode,httpStatus:error.httpStatus} : {code:'unexpected_error',httpStatus:null};
}
function graphqlCode(errors: unknown[]): AnalyticsDiagnosticCode {
  // Never retain or return server messages/extensions: they may contain identifiers,
  // query fragments or credentials. Only a finite diagnostic category crosses here.
  for(const entry of errors) {
    if(!object(entry))continue;
    const message=typeof entry.message==='string'?entry.message:'';
    const extension=object(entry.extensions)&&typeof entry.extensions.code==='string'?entry.extensions.code:'';
    if(/unknown type\b/i.test(message))return 'graphql_unknown_type';
    if(/cannot query field|unknown field|field\b.{0,120}\bnot found/i.test(message))return 'graphql_unknown_field';
    if(/variable\b.{0,120}\b(invalid|expected|required)|invalid (variable|value)|expected type/i.test(message)||extension==='INVALID_VARIABLES'||extension==='BAD_USER_INPUT')return 'graphql_invalid_variable';
    if(/(?:zone|plan|dataset|field|node).{0,180}(?:does not have access|not allowed|not entitled|not available|access denied)|(?:does not have access|not entitled|not available).{0,180}(?:dataset|field|node)/i.test(message))return 'graphql_dataset_forbidden';
    if(/not authori[sz]ed|permission/i.test(message))return 'graphql_unauthorized';
    if(/access denied|not entitled|forbidden/i.test(message)||extension==='FORBIDDEN')return 'graphql_forbidden';
    if(/authentication|unauthenticated|invalid.{0,60}(token|credential)|expired.{0,60}token|unauthori[sz]ed/i.test(message)||extension==='UNAUTHENTICATED')return 'graphql_unauthorized';
    if(/rate.?limit|too many requests/i.test(message)||extension==='RATE_LIMITED'||extension==='TOO_MANY_REQUESTS')return 'graphql_rate_limited';
    if(/syntax error|parse error|parsing/i.test(message)||extension==='GRAPHQL_VALIDATION_FAILED')return 'graphql_query_invalid';
  }
  return 'graphql_error';
}
export async function pollWaf(env: Env, start: number, end: number): Promise<WafRead> {
  if (!env.CF_ANALYTICS_TOKEN) throw new AnalyticsFailure('credential_missing');
  const controller = new AbortController(), deadline = performance.now() + 5000;
  const timer = setTimeout(() => controller.abort(), 5000);
  let response: Response | undefined;
  try {
    response = await Promise.race([
      fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: {Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json'},
        // Analytics requires its custom lowercase string scalar. Its typed filter
        // supplies the schema's timestamp and hostname types without guessing them.
        body: JSON.stringify({query: `query SecurityEvents($zone:string,$filter:FirewallEventsAdaptiveFilter_InputObject) {
          viewer { zones(filter:{zoneTag:$zone}) { firewallEventsAdaptive(limit:1000,
            filter:$filter,orderBy:[datetime_ASC]) {
              action clientRequestHTTPHost datetime
          } } } }`, variables: {zone: ZONE_ID, filter:{datetime_geq:new Date(start).toISOString(),datetime_lt:new Date(end).toISOString(),clientRequestHTTPHost_in:HOSTS}}}),
      }).then(value => {if(performance.now() >= deadline || controller.signal.aborted){if(value.body)void value.body.cancel().catch(()=>undefined);throw new AnalyticsFailure('request_timeout');}return value;}),
      new Promise<Response>((_, reject) => { controller.signal.addEventListener('abort', () => reject(new AnalyticsFailure('request_timeout')), {once:true}); }),
    ]);
    if (performance.now() >= deadline) throw new AnalyticsFailure('request_timeout',response.status);
    if(!response.ok){
      const status=response.status;
      throw new AnalyticsFailure(status===401?'http_unauthorized':status===403?'http_forbidden':status===429?'http_rate_limited':status>=500?'http_server_error':'http_unexpected_status',status);
    }
    const value = await boundedJSON(response, 262144, Math.max(1, Math.min(2000, deadline - performance.now())));
    if (performance.now() >= deadline) throw new AnalyticsFailure('request_timeout',response.status);
    if (!object(value)) throw new AnalyticsFailure('invalid_response',response.status);
    if(value.errors!==undefined&&value.errors!==null){
      if(!Array.isArray(value.errors))throw new AnalyticsFailure('invalid_response',response.status);
      if(value.errors.length)throw new AnalyticsFailure(graphqlCode(value.errors),response.status);
    }
    const data = value.data;
    if (!object(data) || !object(data.viewer) || !Array.isArray(data.viewer.zones)) throw new AnalyticsFailure('invalid_response',response.status);
    if(data.viewer.zones.length!==1)throw new AnalyticsFailure('zone_missing',response.status);
    const zone = data.viewer.zones[0];
    if (!object(zone) || !Array.isArray(zone.firewallEventsAdaptive)) throw new AnalyticsFailure('dataset_missing',response.status);
    const events = zone.firewallEventsAdaptive;
    if(events.length>1000)throw new AnalyticsFailure('invalid_response',response.status);
    const groups = new Map<string,WafGroup>();
    for (const event of events) {
      if(!object(event)||Object.keys(event).some(key=>!['action','clientRequestHTTPHost','datetime'].includes(key))
        ||typeof event.action!=='string'||event.action.length>64
        ||!HOSTS.includes(event.clientRequestHTTPHost as typeof HOSTS[number])
        ||typeof event.datetime!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(event.datetime))throw new AnalyticsFailure('row_invalid',response.status);
      const at=Date.parse(event.datetime);
      if(!Number.isFinite(at)||at<start||at>=end)throw new AnalyticsFailure('row_invalid',response.status);
      // Counts describe observed sampled records, never extrapolated attack totals.
      // Only the requested safe fields are accepted; no raw identities are retained.
      if(!actions.includes(event.action as typeof actions[number]))continue;
      const host=event.clientRequestHTTPHost as typeof HOSTS[number],action=event.action as WafGroup['action'],key=`${host}:${action}`;
      const group=groups.get(key);
      if(group)group.count++;else groups.set(key,{host,action,count:1});
    }
    // Reaching the bounded sample limit does not erase known safe observations.
    return {groups:[...groups.values()],complete:events.length<1000};
  } catch(error) {
    if(error instanceof AnalyticsFailure)throw error;
    if(controller.signal.aborted||performance.now()>=deadline||(error instanceof Error&&error.message==='timeout'))throw new AnalyticsFailure('request_timeout',response?.status??null);
    throw new AnalyticsFailure(response?'invalid_response':'network_error',response?.status??null);
  } finally {clearTimeout(timer); if(response?.body) void response.body.cancel().catch(() => undefined); controller.abort();}
}
