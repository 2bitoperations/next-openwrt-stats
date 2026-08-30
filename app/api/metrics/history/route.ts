import { queryHistory } from '@/lib/server/metrics';
import { getRouter } from '@/lib/server/router';
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

		if (scope !== 'interface' && scope !== 'client' && scope !== 'radio') {
			return new Response(
				JSON.stringify({ success: false, errorMessage: 'Invalid scope' }),
				{ status: 400, headers: { 'Content-Type': 'application/json' } }
			);
		}
		if (!key) {
			return new Response(
				JSON.stringify({ success: false, errorMessage: 'No key provided' }),
				{ status: 400, headers: { 'Content-Type': 'application/json' } }
			);
		}

		let routerId: number | undefined = undefined;
		if (!combined && (scope === 'interface' || scope === 'radio')) {
			if (!displayName) {
				return new Response(
					JSON.stringify({
						success: false,
						errorMessage: `displayName is required for a non-combined ${scope} query`
					}),
					{ status: 400, headers: { 'Content-Type': 'application/json' } }
				);
			}
			const router = await getRouter(displayName);
			if (!router.success) {
				return new Response(JSON.stringify(router), {
					status: 404,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			routerId = router.data.id;
		}

		const response = await queryHistory({
			scope,
			key,
			routerId,
			combined,
			from,
			to
		});
		if (!response.success) {
			return new Response(JSON.stringify(response), {
				status: 400,
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
				errorMessage: 'Something went wrong while fetching metric history'
			}),
			{ status: 500, headers: { 'Content-Type': 'application/json' } }
		);
	}
}
