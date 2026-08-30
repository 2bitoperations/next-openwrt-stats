import { collectTick } from '@/lib/server/metrics';
export const dynamic = 'force-dynamic';

export async function GET() {
	await collectTick();
	return new Response(JSON.stringify({ success: true }), {
		status: 200,
		headers: {
			'Content-Type': 'application/json'
		}
	});
}
