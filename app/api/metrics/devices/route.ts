import { listInterfaceDevices } from '@/lib/server/metrics';
import { getRouter } from '@/lib/server/router';
import { jsonResponse } from '@/lib/server/jsonResponse';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
	try {
		const displayName = new URL(request.url).searchParams.get('displayName');
		if (!displayName) {
			return await jsonResponse(
				{ success: false, errorMessage: 'No displayName provided' },
				400
			);
		}
		const router = await getRouter(displayName);
		if (!router.success) {
			return await jsonResponse(router, 404);
		}
		const response = await listInterfaceDevices(router.data.id);
		if (!response.success) {
			return await jsonResponse(response, 400);
		}
		return await jsonResponse(response);
	} catch (error) {
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Something went wrong while listing interface devices'
			},
			500
		);
	}
}
