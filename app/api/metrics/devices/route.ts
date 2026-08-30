import { listInterfaceDevices } from '@/lib/server/metrics';
import { getRouter } from '@/lib/server/router';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
	try {
		const displayName = new URL(request.url).searchParams.get('displayName');
		if (!displayName) {
			return new Response(
				JSON.stringify({ success: false, errorMessage: 'No displayName provided' }),
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
		const response = await listInterfaceDevices(router.data.id);
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
				errorMessage: 'Something went wrong while listing interface devices'
			}),
			{ status: 500, headers: { 'Content-Type': 'application/json' } }
		);
	}
}
