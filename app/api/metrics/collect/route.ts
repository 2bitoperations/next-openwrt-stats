import { collectTick } from '@/lib/server/metrics';
import { jsonResponse } from '@/lib/server/jsonResponse';
export const dynamic = 'force-dynamic';

export async function GET() {
	await collectTick();
	return await jsonResponse({ success: true });
}
