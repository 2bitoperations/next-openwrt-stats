import { db } from '@/lib/server/dbDriver';
import {
	clientsTable,
	eventTypeIdMap,
	presencesEventTable,
	wifisTable
} from '@/drizzle/schema/schema';
import { and, asc, eq, lte } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { alias } from 'drizzle-orm/sqlite-core';
import { jsonResponse } from '@/lib/server/jsonResponse';

export type PresenceSegment = {
	startTimestamp: number;
	endTimestamp: number;
	router: string;
	ssid: string;
	band: string;
};

export type PresenceSegments =
	| { success: true; data: PresenceSegment[] }
	| { success: false; errorMessage: string };

export async function GET(
	req: NextRequest,
	{ params }: { params: Promise<{ mac: string }> }
) {
	if (process.env.PRESENCE_ENABLED !== 'true') {
		return await jsonResponse(
			{ success: false, errorMessage: 'Presence not enabled' },
			500
		);
	}
	const { mac: clientMac } = await params;
	const { searchParams } = new URL(req.url);
	const from = Number(searchParams.get('from'));
	const to = Number(searchParams.get('to'));

	if (!clientMac || !from || !to) {
		return await jsonResponse(
			{ success: false, errorMessage: 'Missing params' },
			400
		);
	}

	const clientId = await db
		.select({ id: clientsTable.id })
		.from(clientsTable)
		.where(eq(clientsTable.clientMacAddress, clientMac));

	if (!clientId.length) {
		return await jsonResponse({ success: true, data: [] });
	}

	const toWifiAlias = alias(wifisTable, 'toWifi');

	const events = await db
		.select({
			timestamp: presencesEventTable.timestamp,
			eventType: presencesEventTable.eventType,
			toRouter: toWifiAlias.displayName,
			toSSID: toWifiAlias.ssid,
			toBand: toWifiAlias.band
		})
		.from(presencesEventTable)
		.where(
			and(
				eq(presencesEventTable.clientId, clientId[0].id),
				lte(presencesEventTable.timestamp, to * 1000)
			)
		)
		.leftJoin(toWifiAlias, eq(toWifiAlias.id, presencesEventTable.toWifiId))
		.orderBy(asc(presencesEventTable.timestamp));

	const segments: PresenceSegment[] = [];
	let current: { router: string; ssid: string; band: string } | null = null;
	let currentStart = from;

	for (const event of events) {
		const eventTimeSec = event.timestamp / 1000;

		if (eventTimeSec <= from) {
			// Establishes the state the client was in as the window opens.
			current =
				event.eventType === eventTypeIdMap.client_disconnected ||
				!event.toRouter ||
				!event.toSSID ||
				!event.toBand
					? null
					: { router: event.toRouter, ssid: event.toSSID, band: event.toBand };
			continue;
		}

		if (current) {
			segments.push({
				startTimestamp: currentStart,
				endTimestamp: eventTimeSec,
				...current
			});
		}

		if (
			event.eventType === eventTypeIdMap.client_disconnected ||
			!event.toRouter ||
			!event.toSSID ||
			!event.toBand
		) {
			current = null;
		} else {
			current = {
				router: event.toRouter,
				ssid: event.toSSID,
				band: event.toBand
			};
		}
		currentStart = eventTimeSec;
	}

	if (current) {
		segments.push({
			startTimestamp: currentStart,
			endTimestamp: to,
			...current
		});
	}

	return await jsonResponse({ success: true, data: segments });
}
