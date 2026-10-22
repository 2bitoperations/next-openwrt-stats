import { getWifiClients } from '@/lib/server/wifiAPs';
import { NextRequest } from 'next/server';
import { jsonResponse } from '@/lib/server/jsonResponse';

export async function POST(request: NextRequest) {
	try {
		const { ifnames } = await request.json();
		if (!ifnames) {
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'No ifnames provided'
				},
				400
			);
		}
		// TODO: validate ifnames
		const response = await getWifiClients(ifnames);
		if (!response.success) {
			return await jsonResponse(response, 400);
		}
		return await jsonResponse(response);
	} catch (error) {
		console.error(error);
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Something went wrong while fetching wifi clients'
			},
			500
		);
	}
}
