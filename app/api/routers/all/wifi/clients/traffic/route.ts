import { getWifiClientsTraffic } from '@/lib/server/wifiAPs';
import { jsonResponse } from '@/lib/server/jsonResponse';

export async function POST(request: Request) {
	try {
		const body = await request.json();
		if (!body.ifnames) {
			return await jsonResponse(
				{ success: false, errorMessage: 'No ifnames provided' },
				400
			);
		}
		// TODO: Validate ifnames
		const wifiClientsTraffic = await getWifiClientsTraffic(body.ifnames);
		if (!wifiClientsTraffic.success) {
			return await jsonResponse(wifiClientsTraffic, 500);
		}
		return await jsonResponse(wifiClientsTraffic);
	} catch (error) {
		console.error(error);
		return await jsonResponse(
			{ success: false, errorMessage: 'Something went wrong' },
			500
		);
	}
}
