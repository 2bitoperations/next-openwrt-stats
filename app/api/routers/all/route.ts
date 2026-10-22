import { getRouters } from '@/lib/server/router';
import { jsonResponse } from '@/lib/server/jsonResponse';

export async function GET() {
	try {
		const response = await getRouters();
		if (!response.success) {
			return await jsonResponse(response, 400);
		}
		return await jsonResponse(response);
	} catch (error) {
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Something went wrong while fetching routers'
			},
			500
		);
	}
}
