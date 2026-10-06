import 'server-only';
import { getRouters } from './router';
import { ubusCall } from './ubusCalls';
import { fileExecSchema } from '@/types/ubusCalls';

// Per-client (MAC) cumulative traffic counters reported by the routers/APs
// themselves, for clients that hostapd can't see (wired) and as a better
// basis than hostapd for the ones it can. Two router-side sources:
//
//  - macacct (preferred): nftables bridge-family counters per MAC. Counts every
//    frame a client sends/receives - wired or wifi, internet or LAN-local - at
//    the node it is attached to; mesh/uplink ports are excluded on the router
//    side, so each client is counted exactly once and summing across routers
//    is correct. Counters reset when the node reboots.
//  - nlbw (fallback): nlbwmon. Only sees routed traffic between a local and a
//    non-local network, so on a pure bridge/AP node it sees almost nothing,
//    and LAN-local traffic is never counted. Counters reset monthly.
//
// Both print `{"columns": [...], "data": [[...], ...]}` with mac / rx_bytes /
// tx_bytes columns (rx = towards the client).

export type HostSource = 'macacct' | 'nlbw';
type Totals = { [mac: string]: { rxBytes: number; txBytes: number } };

const COMMANDS: Record<HostSource, { command: string; params: string[] }> = {
	macacct: { command: '/usr/sbin/macacct', params: ['show'] },
	nlbw: { command: '/usr/sbin/nlbw', params: ['-c', 'json', '-g', 'mac', 'show'] }
};

// Which source each router has, probed rather than assumed: calling a command
// a router doesn't have (or isn't allowed to run) comes back as an rpcd
// permission error, which ubusCall treats as an expired session and answers
// with a fresh login - on every poll. So probe once without retry, cache the
// answer, and only re-probe a router with no source every few minutes (picks
// up a package installed later).
const REPROBE_SECONDS = 300;
const routerSources = new Map<string, { source: HostSource | null; checkedAt: number }>();

async function readTotals(
	displayName: string,
	source: HostSource,
	attemptRetry: boolean
): Promise<Totals | null> {
	const response = await ubusCall({
		displayName,
		params: ['file', 'exec', COMMANDS[source]],
		attemptRetry
	});
	if (!response.success) return null;
	const parsed = fileExecSchema.safeParse(response.data);
	const stdout = parsed.success ? parsed.data.result[1].stdout : undefined;
	if (!stdout) return null;

	let output: { columns: string[]; data: unknown[][] };
	try {
		output = JSON.parse(stdout);
	} catch {
		return null;
	}
	const macIndex = output.columns?.indexOf('mac') ?? -1;
	const rxIndex = output.columns?.indexOf('rx_bytes') ?? -1;
	const txIndex = output.columns?.indexOf('tx_bytes') ?? -1;
	if (macIndex === -1 || rxIndex === -1 || txIndex === -1) return null;

	const totals: Totals = {};
	for (const row of output.data ?? []) {
		const mac = String(row[macIndex]).toUpperCase();
		if (mac === '00:00:00:00:00:00') continue;
		totals[mac] = {
			rxBytes: Number(row[rxIndex]) || 0,
			txBytes: Number(row[txIndex]) || 0
		};
	}
	return totals;
}

async function routerTotals(
	displayName: string,
	nowSec: number
): Promise<{ source: HostSource; totals: Totals } | null> {
	const known = routerSources.get(displayName);
	if (known?.source) {
		const totals = await readTotals(displayName, known.source, true);
		if (totals) return { source: known.source, totals };
		routerSources.delete(displayName); // package removed or broken - re-probe next poll
		return null;
	}
	if (known && nowSec - known.checkedAt < REPROBE_SECONDS) return null;

	for (const source of ['macacct', 'nlbw'] as const) {
		const totals = await readTotals(displayName, source, false);
		if (totals) {
			routerSources.set(displayName, { source, checkedAt: nowSec });
			return { source, totals };
		}
	}
	routerSources.set(displayName, { source: null, checkedAt: nowSec });
	return null;
}

// Totals per MAC, summed across routers, kept separate per source so the
// caller can pick one basis per client (never add macacct and nlbw for the
// same MAC: nlbw on a router counts the routed share of traffic that a
// downstream node's macacct already counted).
export async function getHostTrafficTotals() {
	const allRouters = await getRouters();
	if (!allRouters.success) return allRouters;

	const nowSec = Math.floor(Date.now() / 1000);
	const bySource: Record<HostSource, Totals> = { macacct: {}, nlbw: {} };
	await Promise.all(
		allRouters.data.map(async (router) => {
			const result = await routerTotals(router.displayName, nowSec);
			if (!result) return;
			const totals = bySource[result.source];
			for (const [mac, t] of Object.entries(result.totals)) {
				totals[mac] ??= { rxBytes: 0, txBytes: 0 };
				totals[mac].rxBytes += t.rxBytes;
				totals[mac].txBytes += t.txBytes;
			}
		})
	);
	return { success: true, data: bySource } as const;
}
