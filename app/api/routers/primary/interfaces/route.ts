import { getNetworkInterfaces } from '@/lib/server/routerInterfaces';

export async function GET(request: Request) {
	try {
		const displayName =
			new URL(request.url).searchParams.get('displayName') || undefined;
		const response = await getNetworkInterfaces(displayName);
		if (!response.success) {
			return new Response(JSON.stringify(response), {
				status: 400,
				headers: {
					'Content-Type': 'application/json'
				}
			});
		}
		return new Response(JSON.stringify(response), {
			status: 200,
			headers: {
				'Content-Type': 'application/json'
			}
		});
	} catch (error) {
		return new Response(
			JSON.stringify({
				success: false,
				errorMessage: 'Something went wrong while fetching network interfaces'
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
