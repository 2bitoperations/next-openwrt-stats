import { getPBRPolicy } from '@/lib/server/pbr';
import { jsonResponse } from '@/lib/server/jsonResponse';

export async function GET() {
	try {
		const response = await getPBRPolicy();
		if (!response.success) {
			return await jsonResponse(response, 400);
		}
		return await jsonResponse(response);
	} catch (error) {
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Something went wrong while fetching pbr policy'
			},
			500
		);
	}
}
