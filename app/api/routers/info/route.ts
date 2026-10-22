import { getRouter } from '@/lib/server/router';
import { getCachedRouterInfo } from '@/lib/server/metrics';
import { routerInfoSchema } from '@/types/ubusCalls';
import { NextRequest } from 'next/server';
import { jsonResponse } from '@/lib/server/jsonResponse';

export type getRouterInfo =
	| {
			success: true;
			data: ReturnType<typeof routerInfoSchema.parse>;
	  }
	| {
			success: false;
			errorMessage: string;
	  };
export async function GET(request: NextRequest) {
	try {
		const displayName = request.nextUrl.searchParams.get('displayName');
		if (!displayName) {
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'No router IP provided'
				},
				400
			);
		}
		const router = await getRouter(displayName);
		if (!router.success) {
			return await jsonResponse(router, 400);
		}

		const response = await getCachedRouterInfo(router.data.id);
		if (!response.success) {
			return await jsonResponse(response, 404);
		}

		return await jsonResponse({
			success: true,
			data: response.data
		});
	} catch (error) {
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Failed to get router info'
			},
			500
		);
	}
}
