import { queryMeshHistory } from '@/lib/server/metrics';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
	try {
		const searchParams = new URL(request.url).searchParams;
		const from = Number(searchParams.get('from')) || Math.floor(Date.now() / 1000) - 3600;
		const to = Number(searchParams.get('to')) || Math.floor(Date.now() / 1000);

		const response = await queryMeshHistory({ from, to });
		if (!response.success) {
			return new Response(JSON.stringify(response), { status: 400, headers: { 'Content-Type': 'application/json' } });
		}
		return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
	} catch (error) {
		return new Response(JSON.stringify({ success: false, errorMessage: 'Failed to fetch mesh history' }), { status: 500 });
	}
}
