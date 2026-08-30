import { listAvailableCombinedKeys } from '@/lib/server/metrics';
export const dynamic = 'force-dynamic';

export async function GET() {
	try {
		const response = await listAvailableCombinedKeys();
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
				errorMessage: 'Something went wrong while checking available keys'
			}),
			{ status: 500, headers: { 'Content-Type': 'application/json' } }
		);
	}
}
