import { getRealTimeTraffic } from '@/lib/server/routerInterfaces';

export async function GET(request: Request) {
	try {
		const searchParams = new URL(request.url).searchParams;
		const device = searchParams.get('device');
		const displayName = searchParams.get('displayName') || undefined;
		if (!device) {
			return new Response(
				JSON.stringify({
					success: false,
					errorMessage: 'No device provided'
				}),
				{
					status: 400,
					headers: {
						'Content-Type': 'application/json'
					}
				}
			);
		}
		const response = await getRealTimeTraffic(device, displayName);
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
				errorMessage: 'Something went wrong while fetching real time traffic'
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
