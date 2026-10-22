import { getWifiAPs } from '@/lib/server/wifiAPs';
import { jsonResponse } from '@/lib/server/jsonResponse';

export async function GET() {
	try {
		const response = await getWifiAPs();
		if (!response.success) {
			return await jsonResponse(response, 400);
		}
		return await jsonResponse(response);
	} catch (error) {
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Something went wrong while fetching wifi APs'
			},
			500
		);
	}
}
