import { getClientRecentSeries } from '@/lib/server/metrics';
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

		const response = await getClientRecentSeries(windowSeconds);
		if (!response.success) {
			return new Response(JSON.stringify(response), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}
		return new Response(JSON.stringify(response), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		});
	} catch (error) {
		return new Response(
			JSON.stringify({
				success: false,
				errorMessage: 'Something went wrong while fetching client recent series'
			}),
			{ status: 500, headers: { 'Content-Type': 'application/json' } }
		);
	}
}
