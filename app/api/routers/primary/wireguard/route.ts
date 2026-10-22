import { getWireguardInterfaces } from '@/lib/server/routerInterfaces';
import { jsonResponse } from '@/lib/server/jsonResponse';

export async function GET() {
	try {
		const response = await getWireguardInterfaces();
		if (!response.success) {
			return await jsonResponse(response, 400);
		}
		return await jsonResponse(response);
	} catch (error) {
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Something went wrong while fetching wireguard interfaces'
			},
			500
		);
	}
}
