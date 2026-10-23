import { jsonResponse } from '@/lib/server/jsonResponse';
export const dynamic = 'force-dynamic';

// Presence events are now recorded by the metrics collector on every client
// poll (lib/server/presence.ts); this endpoint, polled once a minute by the
// old presence-cron.js, has nothing left to do.
export async function GET() {
	return await jsonResponse({ success: true });
}
