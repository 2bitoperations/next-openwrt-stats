import { getClientBandwidthSummary } from '@/lib/server/metrics';
import { jsonResponse } from '@/lib/server/jsonResponse';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
	try {
		const windowSeconds = Number(
			new URL(request.url).searchParams.get('windowSeconds')
		);
		if (!windowSeconds || windowSeconds <= 0) {
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'Invalid or missing windowSeconds'
				},
				400
			);
		}
		const response = await getClientBandwidthSummary(windowSeconds);
		if (!response.success) {
			return await jsonResponse(response, 400);
		}
		return await jsonResponse(response);
	} catch (error) {
		return await jsonResponse(
			{
				success: false,
				errorMessage:
					'Something went wrong while fetching client bandwidth summary'
			},
			500
		);
	}
}
