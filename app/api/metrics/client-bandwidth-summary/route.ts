import { getClientBandwidthSummary } from '@/lib/server/metrics';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
	try {
		const windowSeconds = Number(
			new URL(request.url).searchParams.get('windowSeconds')
		);
		if (!windowSeconds || windowSeconds <= 0) {
			return new Response(
				JSON.stringify({
					success: false,
					errorMessage: 'Invalid or missing windowSeconds'
				}),
				{ status: 400, headers: { 'Content-Type': 'application/json' } }
			);
		}
		const response = await getClientBandwidthSummary(windowSeconds);
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
				errorMessage:
					'Something went wrong while fetching client bandwidth summary'
			}),
			{ status: 500, headers: { 'Content-Type': 'application/json' } }
		);
	}
}
