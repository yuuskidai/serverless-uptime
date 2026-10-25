// Bundled only by the local test suite, never by the deployed Worker entrypoint.
import * as execution from '../src/monitor-execution';
import { deriveTransition } from '../src/state-transition';

export default {
  async fetch(request, env) {
    const input = await request.json();
    let output;
    switch (input.action) {
      case 'claim':
        output = await execution.claimMonitorSlot(env, input.monitorId, input.slotMs, input.configRevision);
        break;
      case 'release':
        await execution.releaseMonitorSlot(env, input.lease);
        output = true;
        break;
      case 'commit': {
        const monitor = input.monitor ?? await env.DB.prepare('SELECT * FROM monitors WHERE id = ?').bind(input.lease.monitorId).first();
        const previous = Object.hasOwn(input, 'previous') ? input.previous : await execution.readMonitorState(env, input.lease.monitorId);
        const transition = deriveTransition(monitor, input.result, previous, Date.now(), input.lease.slotMs, false);
        output = await execution.commitMonitorResult(env, monitor, input.lease, input.result, previous, transition, Date.now(), false);
        break;
      }
      case 'reserve':
        output = await execution.reserveTransitionNotification(env, input.lease);
        break;
      case 'thread':
        await execution.saveAlertThread(env, input.lease, input.thread);
        output = true;
        break;
      default:
        return new Response('Unknown local test action', { status: 400 });
    }
    return Response.json(output);
  },
};
