import { db } from '@/lib/server/dbDriver';
import {
	clientsTable,
	eventTypeIdMap,
	presencesEventTable,
	wifisTable
} from '@/drizzle/schema/schema';
import { desc, eq, lt, gt, and, or, inArray } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { alias } from 'drizzle-orm/sqlite-core';
import z from 'zod';
import { jsonResponse } from '@/lib/server/jsonResponse';

export type PresenceEvent = {
	id: number;
	timestamp: number;
	eventType: (typeof eventTypeIdMap)[keyof typeof eventTypeIdMap];
	clientMac?: string;
	clientName?: string;
	fromRouter: string | null;
	fromSSID: string | null;
	fromBand: string | null;
	toRouter: string | null;
	toSSID: string | null;
	toBand: string | null;
};

const filterSchema = z.object({
	eventType: z
		.string()
		.transform((val) => val.split(',').map((type) => Number(type)))
		.optional(),
	startTime: z
		.string()
		.transform((val) => Number(val))
		.optional(),
	endTime: z
		.string()
		.transform((val) => Number(val))
		.optional()
});

export async function GET(
	req: NextRequest,
	{ params }: { params: Promise<{ mac: string }> }
) {
	if (process.env.PRESENCE_ENABLED !== 'true') {
		return new Response('Not enabled', { status: 500 });
	}
	const { mac: clientMac } = await params;
	if (!clientMac) {
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'No clientMac provided'
			},
			400
		);
	}
	const { searchParams } = new URL(req.url);
	const cursor = searchParams.get('cursor');
	const limit = parseInt(searchParams.get('limit') || '20');
	const filter = filterSchema.safeParse({
		eventType: searchParams.get('eventType'),
		startTime: searchParams.get('startTime') || undefined,
		endTime: searchParams.get('endTime') || undefined
	}).data;

	const clientId = await db
		.select({ id: clientsTable.id })
		.from(clientsTable)
		.where(eq(clientsTable.clientMacAddress, clientMac));
	if (!clientId.length) {
		return await jsonResponse(
			{
				success: true,
				data: [],
				hasMore: false,
				nextCursor: null
			},
			404
		);
	}
	const fromWifiAlias = alias(wifisTable, 'fromWifi');
	const toWifiAlias = alias(wifisTable, 'toWifi');

	const whereConditions: any[] = [
		eq(presencesEventTable.clientId, clientId[0].id)
	];

	if (filter?.eventType) {
		whereConditions.push(
			inArray(
				presencesEventTable.eventType,
				filter.eventType as (typeof eventTypeIdMap)[keyof typeof eventTypeIdMap][]
			)
		);
	}

	if (filter?.startTime) {
		whereConditions.push(gt(presencesEventTable.timestamp, filter.startTime));
	}

	if (filter?.endTime) {
		whereConditions.push(lt(presencesEventTable.timestamp, filter.endTime));
	}

	if (cursor) {
		const [cursorTimestamp, cursorId] = cursor.split('_');
		const cursorTimestampNum = parseInt(cursorTimestamp);
		const cursorIdNum = parseInt(cursorId);

		whereConditions.push(
			or(
				lt(presencesEventTable.timestamp, cursorTimestampNum),
				and(
					eq(presencesEventTable.timestamp, cursorTimestampNum),
					lt(presencesEventTable.id, cursorIdNum)
				)
			)
		);
	}

	const presenceEvent: PresenceEvent[] = await db
		.select({
			id: presencesEventTable.id,
			timestamp: presencesEventTable.timestamp,
			eventType: presencesEventTable.eventType,
			fromRouter: fromWifiAlias.displayName,
			fromSSID: fromWifiAlias.ssid,
			fromBand: fromWifiAlias.band,
			toRouter: toWifiAlias.displayName,
			toSSID: toWifiAlias.ssid,
			toBand: toWifiAlias.band
		})
		.from(presencesEventTable)
		.where(and(...whereConditions))
		.innerJoin(clientsTable, eq(clientsTable.id, presencesEventTable.clientId))
		.leftJoin(
			fromWifiAlias,
			eq(fromWifiAlias.id, presencesEventTable.fromWifiId)
		)
		.leftJoin(toWifiAlias, eq(toWifiAlias.id, presencesEventTable.toWifiId))
		.orderBy(desc(presencesEventTable.timestamp))
		.limit(limit + 1);

	const hasMore = presenceEvent.length > limit;
	const data: PresenceEvent[] = hasMore
		? presenceEvent.slice(0, -1)
		: presenceEvent;
	const nextCursor =
		hasMore && data.length > 0
			? `${data[data.length - 1].timestamp}_${data[data.length - 1].id}`
			: null;

	if (!data.length) {
		return await jsonResponse({
			success: true,
			data: [],
			hasMore: false,
			nextCursor: null
		});
	}
	return await jsonResponse({
		success: true,
		data,
		hasMore,
		nextCursor
	});
}
