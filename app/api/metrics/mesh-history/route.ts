import { compactPoints, queryMeshHistory } from '@/lib/server/metrics';
import { jsonResponse } from '@/lib/server/jsonResponse';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
	try {
		const searchParams = new URL(request.url).searchParams;
		const from =
			Number(searchParams.get('from')) || Math.floor(Date.now() / 1000) - 3600;
		const to = Number(searchParams.get('to')) || Math.floor(Date.now() / 1000);

		const since = Number(searchParams.get('since')) || undefined;

		const response = await queryMeshHistory({ from, to, since });
		if (!response.success) {
			return await jsonResponse(response, 400);
		}
		return await jsonResponse({
			...response,
			data: {
				routers: response.data.routers.map((r) => ({
					...r,
					points: compactPoints(r.points)
				}))
			}
		});
	} catch (error) {
		return await jsonResponse(
			{ success: false, errorMessage: 'Failed to fetch mesh history' },
			500
		);
	}
}
