import { compactPoints, queryHistory } from '@/lib/server/metrics';
import { getRouter } from '@/lib/server/router';
import { jsonResponse } from '@/lib/server/jsonResponse';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
	try {
		const searchParams = new URL(request.url).searchParams;
		const scope = searchParams.get('scope');
		const key = searchParams.get('key');
		const displayName = searchParams.get('displayName') || undefined;
		const combined = searchParams.get('combined') === 'true';
		const now = Math.floor(Date.now() / 1000);
		const from = Number(searchParams.get('from')) || now - 3600;
		const to = Number(searchParams.get('to')) || now;
		const since = Number(searchParams.get('since')) || undefined;

		if (
			scope !== 'interface' &&
			scope !== 'client' &&
			scope !== 'client_lan' &&
			scope !== 'client_wan' &&
			scope !== 'radio' &&
			scope !== 'network'
		) {
			return await jsonResponse(
				{ success: false, errorMessage: 'Invalid scope' },
				400
			);
		}
		if (!key) {
			return await jsonResponse(
				{ success: false, errorMessage: 'No key provided' },
				400
			);
		}

		let routerId: number | undefined = undefined;
		if (!combined && (scope === 'interface' || scope === 'radio')) {
			if (!displayName) {
				return await jsonResponse(
					{
						success: false,
						errorMessage: `displayName is required for a non-combined ${scope} query`
					},
					400
				);
			}
			const router = await getRouter(displayName);
			if (!router.success) {
				return await jsonResponse(router, 404);
			}
			routerId = router.data.id;
		}

		const response = await queryHistory({
			scope,
			key,
			routerId,
			combined,
			from,
			to,
			since
		});
		if (!response.success) {
			return await jsonResponse(response, 400);
		}
		return await jsonResponse({
			...response,
			data: compactPoints(response.data)
		});
	} catch (error) {
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Something went wrong while fetching metric history'
			},
			500
		);
	}
}
