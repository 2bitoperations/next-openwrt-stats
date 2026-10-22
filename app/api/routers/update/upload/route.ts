import 'server-only';
import { NextRequest } from 'next/server';
import { getRouter } from '@/lib/server/router';
import { z } from 'zod';
import { buildResponseSchema } from '../types';
import { ubusCall } from '@/lib/server/ubusCalls';
import { logError } from '@/lib/client/errorLog';
import { jsonResponse } from '@/lib/server/jsonResponse';

const uploadRequestSchema = z.object({
	displayName: z.string(),
	buildStatus: buildResponseSchema,
	routerUpdateInfo: z.object({
		displayName: z.string(),
		hasUpdate: z.boolean(),
		currentVersion: z.string(),
		latestVersion: z.string(),
		target: z.string(),
		profile: z.string(),
		packages: z.array(z.string()).default([]),
		isEfi: z.boolean(),
		rootfs_type: z.string()
	})
});

const uploadImageResponseSchema = z.object({
	size: z.number(),
	checksum: z.string(),
	sha256sum: z.string()
});

const validateFirmwareResponseSchema = z.object({
	valid: z.boolean(),
	allow_backup: z.boolean()
});

export type UploadFirmwareResponse =
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
		const parsedBody = uploadRequestSchema.safeParse(body);

		if (!parsedBody.success) {
			logError({
				errorMessage: 'Invalid request body',
				zodError: parsedBody.error
			});
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'Invalid request body'
				},
				400
			);
		}

		const { displayName, buildStatus, routerUpdateInfo } = parsedBody.data;

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

		if (!buildStatus.bin_dir) {
			logError({
				displayName,
				errorMessage: 'No bin_dir found',
				buildStatus
			});
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'No bin_dir found'
				},
				400
			);
		}

		const allImages = buildStatus.images;
		if (!allImages || allImages.length === 0) {
			logError({
				displayName,
				errorMessage: 'No firmware images found',
				buildStatus
			});
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'No firmware images found'
				},
				400
			);
		}

		const image = allImages
			.filter((img) => img.filesystem === routerUpdateInfo.rootfs_type)
			.filter((img) => {
				const efi_targets = ['armsr', 'loongarch', 'x86'];
				let efi_capable = efi_targets.some((tgt) =>
					routerUpdateInfo.target.startsWith(tgt)
				);
				if (efi_capable) {
					if (routerUpdateInfo.isEfi) {
						return img.type == 'combined-efi';
					} else {
						return img.type == 'combined';
					}
				} else {
					return img.type == 'sysupgrade' || img.type == 'combined';
				}
			})[0];

		if (!image) {
			logError({
				displayName,
				errorMessage: 'No valid firmware image found',
				routerUpdateInfo,
				availableImages: allImages
			});
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'No valid firmware image found'
				},
				400
			);
		}

		const imageResponse = await fetch(
			`https://sysupgrade.openwrt.org/store/${buildStatus.bin_dir}/${image.name}`,
			{
				headers: {
					'User-Agent': 'next-openwrt-stats/2.0.0'
				}
			}
		);

		if (!imageResponse.ok) {
			const errorText = await imageResponse.text();
			logError({
				displayName,
				errorMessage: 'Failed to download sysupgrade image',
				imageUrl: `https://sysupgrade.openwrt.org/store/${buildStatus.bin_dir}/${image.name}`,
				status: imageResponse.status,
				rawResponse: errorText
			});
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'Failed to download sysupgrade image'
				},
				400
			);
		}

		const imageBlob = await imageResponse.blob();

		const uploadForm = new FormData();
		uploadForm.append('sessionid', router.data.session);
		uploadForm.append('filename', `/tmp/firmware.bin`);
		uploadForm.append('filedata', imageBlob);

		const uploadResponse = await fetch(
			`${router.data.routerIP}/cgi-bin/cgi-upload?${Date.now()}`,
			{
				method: 'POST',
				body: uploadForm
			}
		);

		if (!uploadResponse.ok) {
			const errorText = await uploadResponse.text();
			logError({
				displayName,
				errorMessage: 'Failed to upload sysupgrade image to router',
				routerIP: router.data.routerIP,
				status: uploadResponse.status,
				rawResponse: errorText
			});
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'Failed to upload sysupgrade image to router'
				},
				400
			);
		}

		const uploadResponseJson = await uploadResponse.json();
		const uploadResponseSchema =
			uploadImageResponseSchema.safeParse(uploadResponseJson);
		if (!uploadResponseSchema.success) {
			logError({
				displayName,
				errorMessage: 'Failed to parse upload sysupgrade image response',
				zodError: uploadResponseSchema.error,
				rawResponse: uploadResponseJson
			});
			return await jsonResponse(
				{
					success: false,
					errorMessage: 'Failed to upload sysupgrade image to router'
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
				errorMessage: 'Failed to parse validate sysupgrade image response',
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
				validationResult: validateFirmwareParsed.data,
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

		return await jsonResponse({
			success: true
		});
	} catch (error) {
		logError({
			errorMessage: 'Failed to upload sysupgrade',
			error
		});
		return await jsonResponse(
			{
				success: false,
				errorMessage: 'Failed to upload sysupgrade'
			},
			500
		);
	}
}
