import { logError } from '@/lib/client/errorLog';
import { ubusCall } from '@/lib/server/ubusCalls';
import { routerTimezoneSchema } from '@/types/ubusCalls';
import { NextRequest } from 'next/server';
import { jsonResponse } from '@/lib/server/jsonResponse';

export type getRouterTimezone =
	| {
			success: true;
			data: string;
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

		const getTimezoneResponse = await ubusCall({
			displayName,
			params: ['luci', 'getTimezones', {}]
		});

		if (!getTimezoneResponse.success) {
			logError({
				displayName,
				errorMessage: 'Failed to get timezone',
				...getTimezoneResponse
			});
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'Failed to get timezone.'
				},
				400
			);
		}

		const parsedTimezoneResponse = routerTimezoneSchema.safeParse(
			getTimezoneResponse.data
		);
		if (!parsedTimezoneResponse.success) {
			logError({
				displayName,
				errorMessage: 'Failed to parse timezone.',
				zodError: parsedTimezoneResponse.error,
				...getTimezoneResponse
			});
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'Failed to parse router timezone.'
				},
				400
			);
		}
		const activeTimezone = Object.keys(
			parsedTimezoneResponse.data.result[1]
		).find((key) => parsedTimezoneResponse.data.result[1][key].active);

		return await jsonResponse({
			success: true,
			data: activeTimezone || 'UTC'
		});
	} catch (error) {
		logError({
			errorMessage: 'Failed to get router timezone.',
			error
		});
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Failed to get router timezone'
			},
			500
		);
	}
}
