import 'server-only';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { registerRouterAction } from '@/lib/server/routersActions';
import { logError } from '@/lib/client/errorLog';

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
			return new Response(
				JSON.stringify({
					success: false,
					errorMessage: 'Invalid request body',
					issues: parsedBody.error.issues
				}),
				{
					status: 400,
					headers: {
						'Content-Type': 'application/json'
					}
				}
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
			return new Response(JSON.stringify(result), {
				status: 400,
				headers: {
					'Content-Type': 'application/json'
				}
			});
		}

		return new Response(JSON.stringify(result), {
			status: 200,
			headers: {
				'Content-Type': 'application/json'
			}
		});
	} catch (error) {
		logError({
			errorMessage: 'Failed to add router via API',
			error
		});
		return new Response(
			JSON.stringify({
				success: false,
				errorMessage: 'Something went wrong while adding the router'
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
