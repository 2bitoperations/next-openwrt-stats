import { getClientRecentSeries } from '@/lib/server/metrics';
import { jsonResponse } from '@/lib/server/jsonResponse';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
	try {
		const params = new URL(request.url).searchParams;
		const rawWindow = params.get('windowSeconds');
		let windowSeconds = 300;
		if (rawWindow !== null) {
			const parsed = Number(rawWindow);
			if (Number.isFinite(parsed)) {
				windowSeconds = Math.min(300, Math.max(60, parsed));
			}
		}
		windowSeconds = Math.round(windowSeconds);

		const since = Number(params.get('since')) || undefined;

		const response = await getClientRecentSeries(windowSeconds, since);
		if (!response.success) {
			return await jsonResponse(response, 400);
		}
		return await jsonResponse(response);
	} catch (error) {
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Something went wrong while fetching client recent series'
			},
			500
		);
	}
}
