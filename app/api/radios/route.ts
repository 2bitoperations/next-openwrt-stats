import { getCachedWifiRadios } from '@/lib/server/metrics';
import { jsonResponse } from '@/lib/server/jsonResponse';
export const dynamic = 'force-dynamic';

export async function GET() {
	try {
		const response = await getCachedWifiRadios();
		if (!response.success) {
			return await jsonResponse(response, 400);
		}
		return await jsonResponse(response);
	} catch (error) {
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Something went wrong while fetching wifi radios'
			},
			500
		);
	}
}
