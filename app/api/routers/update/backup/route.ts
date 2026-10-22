import 'server-only';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getRouter } from '@/lib/server/router';
import { logError } from '@/lib/client/errorLog';
import { jsonResponse } from '@/lib/server/jsonResponse';

const backupRequestSchema = z.object({
	displayName: z.string().min(1, 'Display name is required')
});

export async function POST(request: NextRequest) {
	try {
		const body = await request.json();
		const parsedBody = backupRequestSchema.safeParse(body);

		if (!parsedBody.success) {
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'Invalid request body'
				},
				400
			);
		}

		const { displayName } = parsedBody.data;

		const router = await getRouter(displayName);
		if (!router.success) {
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'No router found'
				},
				400
			);
		}

		const backupResponse = await fetch(
			`${router.data.routerIP}/cgi-bin/cgi-backup`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded'
				},
				body: `sessionid=${router.data.session}`
			}
		);

		if (!backupResponse.ok) {
			const errorText = await backupResponse.text();
			logError({
				displayName,
				errorMessage: 'Failed to get backup',
				routerIP: router.data.routerIP,
				status: backupResponse.status,
				rawResponse: errorText
			});
			return new Response(
				JSON.stringify({
					success: false,
					errorMessage: 'Failed to get backup',
					errorDetails: errorText
				}),
				{
					status: backupResponse.status,
					headers: {
						'Content-Type': 'application/json'
					}
				}
			);
		}

		return new Response(backupResponse.body, {
			status: 200,
			headers: {
				'Content-Type': 'application/x-targz'
			}
		});
	} catch (error: any) {
		logError({
			errorMessage: 'Failed to get backup',
			error
		});
		return await jsonResponse(
			{
				success: false,
				errorMessage: error?.message
					? `Failed to get backup: ${error.message}`
					: 'Failed to get backup'
			},
			500
		);
	}
}
