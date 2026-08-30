import { getRouter } from '@/lib/server/router';
import { getCachedRouterInfo } from '@/lib/server/metrics';
import { routerInfoSchema } from '@/types/ubusCalls';
import { NextRequest } from 'next/server';

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
			return new Response(
				JSON.stringify({
					success: false,
					errorMessage: 'No router IP provided'
				}),
				{
					status: 400,
					headers: {
						'Content-Type': 'application/json'
					}
				}
			);
		}
		const router = await getRouter(displayName);
		if (!router.success) {
			return new Response(JSON.stringify(router), {
				status: 400,
				headers: {
					'Content-Type': 'application/json'
				}
			});
		}

		const response = await getCachedRouterInfo(router.data.id);
		if (!response.success) {
			return new Response(JSON.stringify(response), {
				status: 404,
				headers: {
					'Content-Type': 'application/json'
				}
			});
		}

		return new Response(
			JSON.stringify({
				success: true,
				data: response.data
			}),
			{
				status: 200,
				headers: {
					'Content-Type': 'application/json'
				}
			}
		);
	} catch (error) {
		return new Response(
			JSON.stringify({
				success: false,
				errorMessage: 'Failed to get router info'
			}),
			{
				status: 500,
				headers: {
					'Content-Type': 'application/json'
				}
			}
		);
	}
}
