import { getLatestWifiClients } from '@/lib/server/metrics';
import { jsonResponse } from '@/lib/server/jsonResponse';
export const dynamic = 'force-dynamic';

export type LatestWifiClientsResponse = ReturnType<typeof getLatestWifiClients>;

export async function GET() {
	try {
		const response = getLatestWifiClients();
		if (!response.success) {
			return await jsonResponse(response, 503);
		}
		return await jsonResponse(response);
	} catch (error) {
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Something went wrong while fetching wifi clients'
			},
			500
		);
	}
}
