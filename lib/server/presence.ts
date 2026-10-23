import 'server-only';
import { db } from './dbDriver';
import {
	clientsTable,
	eventTypeIdMap,
	presencesEventTable,
	prevClientsTable,
	wifisTable
} from '@/drizzle/schema/schema';
import { and, eq } from 'drizzle-orm';
import { getCachedDhcpLeases, type LatestWifiClients } from './metrics';
import { logError } from '../client/errorLog';

// Presence events (connected / moved to another AP or band / disconnected),
// from the collector's station list on every ~5 s client poll. Each client's
// AP is the one the signal series uses (its strongest), so the drilldown's
// AP shading lines up with its signal line. This used to be its own
// once-a-minute live poll of every AP (presence-cron.js -> /api/presence):
// up to a minute late, and a second, different pick of AP.

// A client missing from the poll this long is disconnected (as of when it
// was last seen); shorter gaps - a station between APs mid-roam - are not.
const DISCONNECT_GRACE_SECONDS = 15;

type PresenceState = {
	[mac: string]: { displayName: string; ssid: string; band: string; lastSeen: number };
};

let state: PresenceState | null = null;

async function loadState(nowSec: number): Promise<PresenceState> {
	const rows = await db.select().from(prevClientsTable).where(eq(prevClientsTable.id, 1));
	if (!rows.length) {
		await db.insert(prevClientsTable).values({ id: 1, data: JSON.stringify({}) });
		return {};
	}
	// Rows from before this module have no lastSeen.
	const saved = JSON.parse(rows[0].data) as {
		[mac: string]: { displayName: string; ssid: string; band: string; lastSeen?: number };
	};
	const loaded: PresenceState = {};
	for (const [mac, c] of Object.entries(saved)) {
		loaded[mac] = {
			displayName: c.displayName,
			ssid: c.ssid,
			band: c.band,
			lastSeen: c.lastSeen ?? nowSec
		};
	}
	return loaded;
}

export async function recordPresence(clients: LatestWifiClients, nowSec: number) {
	try {
		state ??= await loadState(nowSec);
		const events: (typeof presencesEventTable.$inferInsert)[] = [];
		let leases: { macAddress: string; deviceName: string }[] | undefined;
		const clientId = async (mac: string) => {
			if (!leases) {
				const cached = await getCachedDhcpLeases();
				leases = cached.success ? cached.data : [];
			}
			return getClientDB(mac, leases ?? []);
		};

		for (const [mac, client] of Object.entries(clients)) {
			const prev = state[mac];
			if (
				!prev ||
				prev.displayName !== client.displayName ||
				prev.ssid !== client.ssid ||
				prev.band !== client.band
			) {
				events.push({
					timestamp: nowSec * 1000,
					clientId: await clientId(mac),
					eventType: prev ? eventTypeIdMap.client_updated : eventTypeIdMap.client_connected,
					fromWifiId: prev ? await getWifiDB(prev) : undefined,
					toWifiId: await getWifiDB(client)
				});
			}
			state[mac] = {
				displayName: client.displayName,
				ssid: client.ssid,
				band: client.band,
				lastSeen: nowSec
			};
		}
		for (const [mac, prev] of Object.entries(state)) {
			if (clients[mac] || nowSec - prev.lastSeen <= DISCONNECT_GRACE_SECONDS) continue;
			events.push({
				timestamp: prev.lastSeen * 1000,
				clientId: await clientId(mac),
				eventType: eventTypeIdMap.client_disconnected,
				fromWifiId: await getWifiDB(prev)
			});
			delete state[mac];
		}

		if (events.length) {
			await db.insert(presencesEventTable).values(events);
			await db
				.update(prevClientsTable)
				.set({ data: JSON.stringify(state) })
				.where(eq(prevClientsTable.id, 1));
		}
	} catch (error) {
		logError({ errorMessage: 'presence: failed to record events', error });
	}
}

// The client's id, created on first sight with its DHCP name (or 'Unknown');
// a changed DHCP name is copied over.
async function getClientDB(
	mac: string,
	leases: { macAddress: string; deviceName: string }[]
) {
	const lease = leases.find((l) => l.macAddress.toUpperCase() === mac);
	const existing = await db
		.select({ id: clientsTable.id, clientName: clientsTable.clientName })
		.from(clientsTable)
		.where(eq(clientsTable.clientMacAddress, mac));
	if (!existing.length) {
		const inserted = await db
			.insert(clientsTable)
			.values({ clientName: lease?.deviceName ?? 'Unknown', clientMacAddress: mac })
			.returning({ id: clientsTable.id });
		return inserted[0].id;
	}
	if (
		lease &&
		lease.deviceName !== existing[0].clientName &&
		lease.deviceName !== 'Unknown' &&
		lease.deviceName !== 'Unknown Device'
	) {
		await db
			.update(clientsTable)
			.set({ clientName: lease.deviceName })
			.where(eq(clientsTable.clientMacAddress, mac));
	}
	return existing[0].id;
}

async function getWifiDB({
	displayName,
	ssid,
	band
}: {
	displayName: string;
	ssid: string;
	band: string;
}) {
	const existing = await db
		.select({ id: wifisTable.id })
		.from(wifisTable)
		.where(
			and(
				eq(wifisTable.displayName, displayName),
				eq(wifisTable.ssid, ssid),
				eq(wifisTable.band, band)
			)
		);
	if (existing.length) return existing[0].id;
	const inserted = await db
		.insert(wifisTable)
		.values({ displayName, ssid, band })
		.returning({ id: wifisTable.id });
	return inserted[0].id;
}
