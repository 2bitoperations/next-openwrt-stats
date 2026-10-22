import 'server-only';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { buildResponseSchema } from '../types';
import { logError } from '@/lib/client/errorLog';
import { jsonResponse } from '@/lib/server/jsonResponse';

const statusRequestSchema = z.object({
	requestHash: z.string().min(1, 'Request hash is required')
});

export async function POST(request: NextRequest) {
	try {
		const body = await request.json();
		const parsedBody = statusRequestSchema.safeParse(body);

		if (!parsedBody.success) {
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'Invalid request body'
				},
				400
			);
		}

		const { requestHash } = parsedBody.data;

		const statusResponse = await fetch(
			`https://sysupgrade.openwrt.org/api/v1/build/${requestHash}`,
			{
				method: 'GET',
				headers: {
					'User-Agent': 'next-openwrt-stats/2.0.0'
				}
			}
		);

		if (!statusResponse.ok) {
			const errorText = await statusResponse.text();
			logError({
				errorMessage: 'Failed to check build status',
				requestHash,
				status: statusResponse.status,
				rawResponse: errorText
			});
			return new Response(
				JSON.stringify({
					success: false,
					errorMessage: 'Failed to check build status',
					errorDetails: errorText
				}),
				{
					status: statusResponse.status,
					headers: {
						'Content-Type': 'application/json'
					}
				}
			);
		}

		const statusData = await statusResponse.json();

		const parsedStatusData = buildResponseSchema.safeParse(statusData);
		if (!parsedStatusData.success) {
			logError({
				errorMessage: 'Failed to parse build status response',
				requestHash,
				zodError: parsedStatusData.error,
				rawResponse: statusData
			});
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'Failed to parse build status response'
				},
				500
			);
		}

		return await jsonResponse({
			success: true,
			data: parsedStatusData.data
		});
	} catch (error: any) {
		logError({
			errorMessage: 'Failed to check build status',
			error
		});
		return await jsonResponse(
			{
				success: false,
				errorMessage: error.message
					? `Failed to check build status: ${error.message}`
					: 'Failed to check build status',
				errorDetails: error?.cause
			},
			500
		);
	}
}
