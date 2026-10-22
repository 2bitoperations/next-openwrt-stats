import 'server-only';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { registerRouterAction } from '@/lib/server/routersActions';
import { logError } from '@/lib/client/errorLog';
import { jsonResponse } from '@/lib/server/jsonResponse';

const addRouterRequestSchema = z.object({
	displayName: z.string().min(1, 'Display name is required'),
	routerIP: z.string().min(1, 'Router IP/URL is required'),
	username: z.string().min(1, 'Username is required'),
	password: z.string().min(1, 'Password is required'),
	isPrimary: z.boolean().optional().default(false)
});

export async function POST(request: NextRequest) {
	try {
		const body = await request.json();
		const parsedBody = addRouterRequestSchema.safeParse(body);

		if (!parsedBody.success) {
			logError({
				errorMessage: 'Invalid request body',
				zodError: parsedBody.error
			});
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'Invalid request body',
					issues: parsedBody.error.issues
				},
				400
			);
		}

		const { displayName, routerIP, username, password, isPrimary } =
			parsedBody.data;

		const result = await registerRouterAction(
			displayName,
			routerIP,
			username,
			password,
			isPrimary
		);

		if (!result.success) {
			return await jsonResponse(result, 400);
		}

		return await jsonResponse(result);
	} catch (error) {
		logError({
			errorMessage: 'Failed to add router via API',
			error
		});
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Something went wrong while adding the router'
			},
			500
		);
	}
}
