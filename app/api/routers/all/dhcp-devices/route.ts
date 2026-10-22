import { getCachedDhcpLeases } from '@/lib/server/metrics';
import { jsonResponse } from '@/lib/server/jsonResponse';

export async function GET() {
	try {
		const response = await getCachedDhcpLeases();
		if (!response.success) {
			return await jsonResponse(response, 400);
		}
		return await jsonResponse(response);
	} catch (error) {
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Something went wrong while fetching dhcp devices'
			},
			500
		);
	}
}
