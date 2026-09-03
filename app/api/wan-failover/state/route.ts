import { getRouter } from '@/lib/server/router';
import { getCachedWanFailoverState } from '@/lib/server/metrics';
import { NextRequest } from 'next/server';

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
			return new Response(
				JSON.stringify({ success: false, errorMessage: 'No displayName provided' }),
				{ status: 400, headers: { 'Content-Type': 'application/json' } }
			);
		}
		const router = await getRouter(displayName);
		if (!router.success) {
			return new Response(JSON.stringify(router), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const response = await getCachedWanFailoverState(router.data.id);
		if (!response.success) {
			return new Response(JSON.stringify(response), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		return new Response(JSON.stringify(response), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		});
	} catch (error) {
		return new Response(
			JSON.stringify({
				success: false,
				errorMessage: 'Failed to get WAN failover state'
			}),
			{ status: 500, headers: { 'Content-Type': 'application/json' } }
		);
	}
}
