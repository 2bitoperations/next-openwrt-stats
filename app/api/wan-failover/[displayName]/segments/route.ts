import { db } from '@/lib/server/dbDriver';
import { wanFailoverEventTable } from '@/drizzle/schema/schema';
import { getRouter } from '@/lib/server/router';
import { and, asc, eq, lte } from 'drizzle-orm';
import { NextRequest } from 'next/server';

// Mirrors app/api/presence/[mac]/segments/route.ts's discrete-events ->
// continuous-segments folding, minus the client/wifi joins (this is a
// single router's own state, not per-client roaming history).
export type WanFailoverSegment = {
	startTimestamp: number;
	endTimestamp: number;
	activeInterface: 'primary' | 'backup';
};

export type WanFailoverSegments =
	| { success: true; data: WanFailoverSegment[] }
	| { success: false; errorMessage: string };

export async function GET(
	req: NextRequest,
	{ params }: { params: Promise<{ displayName: string }> }
) {
	const { displayName } = await params;
	const { searchParams } = new URL(req.url);
	const from = Number(searchParams.get('from'));
	const to = Number(searchParams.get('to'));

	if (!displayName || !from || !to) {
		return new Response(
			JSON.stringify({ success: false, errorMessage: 'Missing params' }),
			{ status: 400, headers: { 'Content-Type': 'application/json' } }
		);
	}

	const router = await getRouter(displayName);
	if (!router.success) {
		return new Response(JSON.stringify({ success: true, data: [] }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const events = await db
		.select({
			timestamp: wanFailoverEventTable.timestamp,
			activeInterface: wanFailoverEventTable.activeInterface
		})
		.from(wanFailoverEventTable)
		.where(
			and(
				eq(wanFailoverEventTable.routerId, router.data.id),
				lte(wanFailoverEventTable.timestamp, to)
			)
		)
		.orderBy(asc(wanFailoverEventTable.timestamp));

	const segments: WanFailoverSegment[] = [];
	let current: 'primary' | 'backup' | null = null;
	let currentStart = from;

	for (const event of events) {
		if (event.timestamp <= from) {
			// Establishes the state the window opens in.
			current = event.activeInterface;
			continue;
		}

		if (current) {
			segments.push({
				startTimestamp: currentStart,
				endTimestamp: event.timestamp,
				activeInterface: current
			});
		}

		current = event.activeInterface;
		currentStart = event.timestamp;
	}

	if (current) {
		segments.push({
			startTimestamp: currentStart,
			endTimestamp: to,
			activeInterface: current
		});
	}

	return new Response(JSON.stringify({ success: true, data: segments }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});
}
