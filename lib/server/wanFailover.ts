import 'server-only';
import { ubusCall } from './ubusCalls';
import { fileExecSchema } from '@/types/ubusCalls';
import { logError } from '../client/errorLog';

export type WanFailoverActiveInterface = 'primary' | 'backup';

export type WanFailoverState = {
	activeInterface: WanFailoverActiveInterface;
	since: number; // epoch seconds
};

// Reads /tmp/run/wan-failover-state (written by wan-failover.sh, see this
// project's NOTES.md) via the same rpcd `file exec` allowlist pattern used
// for nlbwmon - a plain `active=.../since=.../updated=...` key=value file,
// not JSON, so no parsing library is needed on either end.
//
// `data: null` means this router isn't running the watchdog at all - not an
// error, most routers in this deployment are pure mesh points with no WAN
// concept.
export async function fetchWanFailoverState(displayName: string): Promise<
	| { success: true; data: WanFailoverState | null }
	| { success: false; errorMessage: string }
> {
	const response = await ubusCall({
		displayName,
		params: [
			'file',
			'exec',
			{ command: '/bin/cat', params: ['/tmp/run/wan-failover-state'] }
		]
	});

	if (!response.success) {
		logError({
			displayName,
			errorMessage: 'Failed to exec cat wan-failover-state',
			...response
		});
		return {
			success: false,
			errorMessage: 'Failed to read WAN failover state'
		};
	}

	const parsed = fileExecSchema.safeParse(response.data);
	if (!parsed.success || !parsed.data.result[1].stdout) {
		// ACL denied (stale pre-grant session), command failed, or this
		// router simply doesn't run the watchdog - none of these are worth
		// surfacing as an error to the caller.
		return { success: true, data: null };
	}

	const kv: { [key: string]: string } = {};
	for (const line of parsed.data.result[1].stdout.split('\n')) {
		const eq = line.indexOf('=');
		if (eq === -1) continue;
		kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}

	if (kv.active !== 'primary' && kv.active !== 'backup') {
		return { success: true, data: null };
	}
	const since = Number(kv.since);
	if (!Number.isFinite(since)) {
		return { success: true, data: null };
	}

	return { success: true, data: { activeInterface: kv.active, since } };
}
