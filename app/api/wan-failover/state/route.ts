import { getRouter } from '@/lib/server/router';
import { getCachedWanFailoverState } from '@/lib/server/metrics';
import { NextRequest } from 'next/server';
import { jsonResponse } from '@/lib/server/jsonResponse';

export type GetWanFailoverState =
	| {
			success: true;
			data: {
				routerId: number;
				activeInterface: 'primary' | 'backup';
				since: number;
				updatedAt: number;
			} | null;
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
				{ success: false, errorMessage: 'No displayName provided' },
				400
			);
		}
		const router = await getRouter(displayName);
		if (!router.success) {
			return await jsonResponse(router, 400);
		}

		const response = await getCachedWanFailoverState(router.data.id);
		if (!response.success) {
			return await jsonResponse(response, 500);
		}

		return await jsonResponse(response);
	} catch (error) {
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Failed to get WAN failover state'
			},
			500
		);
	}
}
