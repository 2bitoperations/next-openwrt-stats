import { getNetworkInterfaces } from '@/lib/server/routerInterfaces';
import { jsonResponse } from '@/lib/server/jsonResponse';

export async function GET(request: Request) {
	try {
		const displayName =
			new URL(request.url).searchParams.get('displayName') || undefined;
		const response = await getNetworkInterfaces(displayName);
		if (!response.success) {
			return await jsonResponse(response, 400);
		}
		return await jsonResponse(response);
	} catch (error) {
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Something went wrong while fetching network interfaces'
			},
			500
		);
	}
}
