import { getLatestInterfaceRate } from '@/lib/server/metrics';
import { jsonResponse } from '@/lib/server/jsonResponse';

export async function GET(request: Request) {
	try {
		const searchParams = new URL(request.url).searchParams;
		const device = searchParams.get('device');
		const displayName = searchParams.get('displayName') || undefined;
		if (!device) {
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'No device provided'
				},
				400
			);
		}
		const response = await getLatestInterfaceRate(device, displayName);
		if (!response.success) {
			return await jsonResponse(response, 400);
		}
		return await jsonResponse(response);
	} catch (error) {
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Something went wrong while fetching real time traffic'
			},
			500
		);
	}
}
