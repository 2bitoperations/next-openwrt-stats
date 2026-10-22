import 'server-only';
import { db } from '@/lib/server/dbDriver';
import { routersTable } from '@/drizzle/schema/schema';
import { eq } from 'drizzle-orm';
import { ubusBatchCall } from '@/lib/server/ubusCalls';
import { NextRequest } from 'next/server';
import { logError } from '@/lib/client/errorLog';
import { jsonResponse } from '@/lib/server/jsonResponse';

export type RouterLogs = Awaited<
	| {
			success: true;
			data:
				| {
						logs: string[];
						version: 1;
				  }
				| {
						logs: {
							msg: string;
							id: number;
							priority: number;
							source: number;
							time: number;
						}[];
						version: 2;
				  };
	  }
	| {
			success: false;
			errorMessage: string;
	  }
>;
export async function GET(request: NextRequest) {
	try {
		const displayName = request.nextUrl.searchParams.get('displayName');
		if (!displayName) {
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'No router name provided'
				},
				400
			);
		}
		const router = await db
			.select({
				routerIP: routersTable.routerIP
			})
			.from(routersTable)
			.where(eq(routersTable.displayName, displayName))
			.limit(1);

		if (!router.length) {
			logError({
				displayName,
				errorMessage: 'This router does not exist.'
			});
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'This router does not exist.'
				},
				400
			);
		}

		const logsCall = await ubusBatchCall({
			displayName: displayName,
			calls: [
				{
					id: 1,
					params: [
						'file',
						'exec',
						{
							command: '/usr/libexec/syslog-wrapper'
						}
					]
				},
				{
					id: 2,
					params: ['log', 'read', { lines: 1000, stream: false, oneshot: true }]
				}
			]
		});

		if (!logsCall.success) {
			logError({
				displayName,
				errorMessage: 'Failed to get logs',
				...logsCall
			});
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'Failed to get logs.'
				},
				400
			);
		}
		const oldLogCall = logsCall.data.find((call) => call.id === 1);
		const newLogCall = logsCall.data.find((call) => call.id === 2);
		if (oldLogCall?.success && oldLogCall.result?.[1]?.stdout) {
			const logs = (oldLogCall.result[1].stdout as string)
				.trimEnd()
				.split('\n');
			return await jsonResponse({
				success: true,
				data: {
					logs,
					version: 1
				}
			});
		}

		if (newLogCall?.success && newLogCall.result?.[1]?.log) {
			const logs = newLogCall.result[1].log;
			return await jsonResponse({
				success: true,
				data: {
					logs,
					version: 2
				}
			});
		}

		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Failed to get logs.'
			},
			400
		);
	} catch (error) {
		logError({
			errorMessage: 'Something went wrong while getting the router logs',
			error
		});
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Failed to get router logs.'
			},
			500
		);
	}
}
