import 'server-only';
import { NextRequest } from 'next/server';
import { getRouter } from '@/lib/server/router';
import { z } from 'zod';
import { ubusCall } from '@/lib/server/ubusCalls';
import { logError } from '@/lib/client/errorLog';
import { jsonResponse } from '@/lib/server/jsonResponse';

const executeRequestSchema = z.object({
	displayName: z.string().min(1, 'Display name is required')
});

const validateFirmwareResponseSchema = z.object({
	valid: z.boolean(),
	allow_backup: z.boolean()
});

export type FirmwareUpdateExecuteResponse =
	| {
			success: true;
	  }
	| {
			success: false;
			errorMessage: string;
	  };

export async function POST(request: NextRequest) {
	try {
		const body = await request.json();
		const parsedBody = executeRequestSchema.safeParse(body);

		if (!parsedBody.success) {
			logError({
				errorMessage: 'Invalid request body',
				zodError: parsedBody.error
			});
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'Failed to validate sysupgrade image'
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

		const validateFirmware = await ubusCall({
			displayName,
			params: [
				'system',
				'validate_firmware_image',
				{
					path: '/tmp/firmware.bin'
				}
			]
		});

		if (!validateFirmware.success) {
			logError({
				displayName,
				errorMessage: 'Failed to validate sysupgrade image',
				...validateFirmware
			});
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'Failed to validate sysupgrade image'
				},
				400
			);
		}

		const validateFirmwareParsed = validateFirmwareResponseSchema.safeParse(
			validateFirmware.data.result[1]
		);

		if (!validateFirmwareParsed.success) {
			logError({
				displayName,
				errorMessage: 'Failed to validate sysupgrade image',
				zodError: validateFirmwareParsed.error,
				...validateFirmware
			});
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'Failed to validate sysupgrade image'
				},
				400
			);
		}

		if (
			!validateFirmwareParsed.data.valid &&
			!validateFirmwareParsed.data.allow_backup
		) {
			logError({
				displayName,
				errorMessage: 'Failed to validate sysupgrade image',
				...validateFirmware
			});
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'Failed to validate sysupgrade image'
				},
				400
			);
		}

		const sysupgradeUbusCall = await ubusCall({
			displayName,
			params: [
				'file',
				'exec',
				{
					command: `/sbin/sysupgrade`,
					params: ['/tmp/firmware.bin']
				}
			],
			attemptRetry: false
		});

		if (!sysupgradeUbusCall.success) {
			logError({
				displayName,
				errorMessage: 'Failed to execute sysupgrade',
				...sysupgradeUbusCall
			});
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'Failed to execute sysupgrade'
				},
				400
			);
		}

		return await jsonResponse({
			success: true
		});
	} catch (error) {
		logError({
			errorMessage: 'Failed to execute sysupgrade',
			error
		});
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Failed to execute sysupgrade'
			},
			500
		);
	}
}
