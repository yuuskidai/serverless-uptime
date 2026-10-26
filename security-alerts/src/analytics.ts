import { HOSTS, ZONE_ID } from './types';
import type { Env, WafGroup } from './types';
import { boundedJSON, object } from './validation';
const actions = ['block', 'managed_challenge', 'js_challenge', 'challenge', 'log'] as const;
export async function pollWaf(env: Env, start: number, end: number): Promise<WafGroup[]> {
  if (!env.CF_ANALYTICS_TOKEN) throw new Error('analytics_unavailable');
  const controller = new AbortController(), deadline = performance.now() + 5000;
  const timer = setTimeout(() => controller.abort(), 5000);
  let response: Response | undefined;
  try {
    response = await Promise.race([
      fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: {Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({query: `query SecurityEvents($zone:String!,$start:Time!,$end:Time!,$hosts:[String!]) {
          viewer { zones(filter:{zoneTag:$zone}) { firewallEventsAdaptiveGroups(limit:100,
            filter:{datetime_geq:$start,datetime_lt:$end,clientRequestHTTPHost_in:$hosts},orderBy:[count_DESC]) {
              count dimensions { action clientRequestHTTPHost }
          } } } }`, variables: {zone: ZONE_ID, start: new Date(start).toISOString(), end: new Date(end).toISOString(), hosts: HOSTS}}),
      }).then(value => {if(performance.now() >= deadline || controller.signal.aborted){if(value.body)void value.body.cancel().catch(()=>undefined);throw new Error('analytics_unavailable');}return value;}),
      new Promise<Response>((_, reject) => { controller.signal.addEventListener('abort', () => reject(new Error('analytics_unavailable')), {once:true}); }),
    ]);
    if (performance.now() >= deadline || !response.ok) throw new Error('analytics_unavailable');
    const value = await boundedJSON(response, 65536, Math.max(1, Math.min(2000, deadline - performance.now())));
    if (performance.now() >= deadline || !object(value) || (value.errors !== undefined && value.errors !== null && (!Array.isArray(value.errors) || value.errors.length))) throw new Error('analytics_unavailable');
    const data = value.data;
    if (!object(data) || !object(data.viewer) || !Array.isArray(data.viewer.zones) || data.viewer.zones.length !== 1) throw new Error('analytics_unavailable');
    const zone = data.viewer.zones[0];
    if (!object(zone) || !Array.isArray(zone.firewallEventsAdaptiveGroups)) throw new Error('analytics_unavailable');
    const groups = zone.firewallEventsAdaptiveGroups;
    if (groups.length >= 100) throw new Error('analytics_gap'); // No false completeness at the response cap.
    const result: WafGroup[] = [];
    for (const group of groups) {
      if (!object(group) || !object(group.dimensions) || !Number.isSafeInteger(group.count) || (group.count as number) < 0 || (group.count as number) > 1_000_000_000) throw new Error('analytics_unavailable');
      const d = group.dimensions;
      if (!HOSTS.includes(d.clientRequestHTTPHost as typeof HOSTS[number])) throw new Error('analytics_unavailable');
      // Exclude requests allowed/skipped by rules. A block/challenge is an observation, not proof of intrusion.
      if (!actions.includes(d.action as typeof actions[number]) || group.count === 0) continue;
      if (d.ruleId !== null && d.ruleId !== undefined && (typeof d.ruleId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(d.ruleId))) throw new Error('analytics_unavailable');
      result.push({action: d.action as WafGroup['action'], host: d.clientRequestHTTPHost as WafGroup['host'], count: group.count as number,
        ...(typeof d.ruleId === 'string' ? {ruleId:d.ruleId} : {})});
    }
    return result;
  } finally {clearTimeout(timer); if(response?.body) void response.body.cancel().catch(() => undefined); controller.abort();}
}
