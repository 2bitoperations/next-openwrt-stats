import 'server-only';
import {
	batchResponseSchema,
	validResponseSchema,
	loginSchema,
	accessDeniedSchema
} from '@/types/ubusCalls';
import { db } from './dbDriver';
import { routersTable } from '@/drizzle/schema/schema';
import { eq } from 'drizzle-orm';
import { logError } from '../client/errorLog';

type UbusCallReturnType =
	| {
			success: true;
			data: {
				jsonrpc: string;
				id: number;
				result: [number, any];
			};
			call: object;
			rawResponse: object;
	  }
	| {
			success: false;
			ubusErrorMessage: string;
			call: object;
			rawResponse?: object;
			error?: unknown;
			loginRawResponse?: object;
			loginCall?: object;
	  };

export async function ubusCall({
	displayName,
	params,
	attemptRetry = true
}: {
	displayName: string;
	params: [string, string, { [key: string]: any }];
	attemptRetry?: boolean;
}): Promise<UbusCallReturnType> {
	try {
		const session = await getSession(displayName);
		if (!session.success) {
			return {
				...session,
				call: params
			};
		}
		const ubusObject = {
			jsonrpc: '2.0',
			id: 1,
			method: 'call',
			params: [session.data.sessionKey, ...params]
		};

		let callResponse = await sendUbus(session.data.routerIP, ubusObject);
		if (!callResponse.success && attemptRetry) {
			const newLogin = await dedupedLogin({
				routerIP: session.data.routerIP,
				username: session.data.username,
				password: session.data.password
			});

			if (!newLogin.success) {
				return {
					...newLogin,
					call: params
				};
			}
			const newUbusObject = {
				jsonrpc: '2.0',
				id: 1,
				method: 'call',
				params: [newLogin.data.ubus_rpc_session, ...params]
			};
			callResponse = await sendUbus(session.data.routerIP, newUbusObject);
			if (!callResponse.success) {
				return callResponse;
			}
		}
		if (!callResponse.success) {
			return callResponse;
		}
		await updateLastAccessed(displayName);
		return callResponse;
	} catch (error) {
		return {
			success: false,
			ubusErrorMessage: 'Something went wrong while executing the command.',
			call: params,
			error
		};
	}
}

type UbusBatchCallReturnType = Promise<
	| {
			success: true;
			data: UbusBatchResponses[];
	  }
	| {
			success: false;
			ubusErrorMessage: string;
			calls: object;
			rawResponse?: object;
			error?: unknown;
			loginRawResponse?: object;
			loginCall?: object;
	  }
>;

export async function ubusBatchCall({
	displayName,
	calls,
	attemptRetry = true
}: {
	displayName: string;
	calls: {
		id: number | string;
		params: [string, string, { [key: string]: any }];
	}[];
	attemptRetry?: boolean;
}): UbusBatchCallReturnType {
	try {
		const session = await getSession(displayName);
		if (!session.success) {
			return {
				...session,
				calls
			} as const;
		}
		const ubusObjects = calls.map((call) => ({
			jsonrpc: '2.0',
			id: call.id,
			method: 'call',
			params: [session.data.sessionKey, ...call.params]
		}));

		let batchResponse = await sendUbusBatch(session.data.routerIP, ubusObjects);
		if (!batchResponse.success && attemptRetry) {
			const newLogin = await dedupedLogin({
				routerIP: session.data.routerIP,
				username: session.data.username,
				password: session.data.password
			});
			if (!newLogin.success) {
				return {
					...newLogin,
					calls
				} as const;
			}

			const retriedUbusObjects = calls.map((call) => ({
				jsonrpc: '2.0',
				id: call.id,
				method: 'call',
				params: [newLogin.data.ubus_rpc_session, ...call.params]
			}));

			batchResponse = await sendUbusBatch(
				session.data.routerIP,
				retriedUbusObjects
			);
			if (!batchResponse.success) {
				return {
					...batchResponse
				} as const;
			}
		}
		if (!batchResponse.success) {
			return {
				...batchResponse
			} as const;
		}
		if (
			batchResponse.hasAccessDenied &&
			batchResponse.hasAccessDenied.every((hasAccessDenied) => hasAccessDenied)
		) {
			dedupedLogin({
				// TODO: We should retry all the ubus calls here
				// Because if we are getting access denied, it means
				// all the calls failed due to expired session
				routerIP: session.data.routerIP,
				username: session.data.username,
				password: session.data.password
			});
		}
		await updateLastAccessed(displayName);
		return { success: true, data: batchResponse.data } as const;
	} catch (error) {
		return {
			success: false,
			ubusErrorMessage: 'Something went wrong while executing the command.',
			calls,
			error
		} as const;
	}
}

const loginPromises = new Map<string, LoginReturnType>();
async function dedupedLogin({
	routerIP,
	username,
	password
}: {
	routerIP: string;
	username: string;
	password: string;
}) {
	if (loginPromises.has(routerIP)) {
		return loginPromises.get(routerIP)!;
	}
	const promise = login({ routerIP, username, password }).finally(() => {
		loginPromises.delete(routerIP);
	});

	loginPromises.set(routerIP, promise);
	return promise;
}

type LoginReturnType = Promise<
	| {
			success: true;
			data: {
				ubus_rpc_session: string;
				timeout: number;
				expires: number;
			};
	  }
	| {
			success: false;
			ubusErrorMessage: string;
			error?: unknown;
			loginRawResponse?: object;
			loginCall?: object;
	  }
>;
export async function login({
	routerIP,
	username,
	password,
	isNew
}: {
	routerIP: string;
	username: string;
	password: string;
	isNew?: boolean;
}): LoginReturnType {
	const ubusObject = {
		jsonrpc: '2.0',
		id: 1,
		method: 'call',
		params: [
			'00000000000000000000000000000000',
			'session',
			'login',
			{
				username,
				password,
				timeout: 3600
			}
		]
	};

	try {
		const response = await routerFetch(routerIP, JSON.stringify(ubusObject));

		const ubusResponse = await response.json();
		const parsedUbusResponse = loginSchema.safeParse(ubusResponse);
		if (!parsedUbusResponse.success) {
			return {
				success: false,
				error: parsedUbusResponse.error,
				ubusErrorMessage: 'Failed to parse ubus login response',
				loginRawResponse: ubusResponse,
				loginCall: ubusObject
			};
		}

		if (parsedUbusResponse.data.result[0] === 6) {
			return {
				success: false,
				ubusErrorMessage: 'Login failed due to bad credentials',
				loginRawResponse: ubusResponse,
				loginCall: ubusObject
			};
		}

		if (!isNew) {
			await db
				.update(routersTable)
				.set({
					lastAccessed: Date.now(),
					session: parsedUbusResponse.data.result[1].ubus_rpc_session
				})
				.where(eq(routersTable.routerIP, routerIP));
		}

		return {
			success: true,
			data: parsedUbusResponse.data.result[1]
		};
	} catch (error) {
		return {
			success: false,
			error,
			ubusErrorMessage:
				'Fetch request failed during login. Please check your router IP and make sure it is reachable'
		};
	}
}

async function updateLastAccessed(displayName: string) {
	try {
		await db
			.update(routersTable)
			.set({ lastAccessed: Date.now() })
			.where(eq(routersTable.displayName, displayName));
	} catch (error) {
		logError({
			displayName,
			errorMessage:
				'Failed to update lastAccessed in DB after a successful ubus call',
			error
		});
	}
}

async function getSession(displayName: string) {
	try {
		const [session] = await db
			.select({
				routerIP: routersTable.routerIP,
				sessionKey: routersTable.session,
				username: routersTable.username,
				password: routersTable.password,
				lastAccessed: routersTable.lastAccessed
			})
			.from(routersTable)
			.where(eq(routersTable.displayName, displayName))
			.limit(1);

		let sessionKey = session.sessionKey;

		if (loginPromises.has(displayName)) {
			const response = await loginPromises.get(displayName)!;
			if (response.success) sessionKey = response.data.ubus_rpc_session;
		} else if (session.lastAccessed + 3_500_000 < Date.now()) {
			const newLogin = await dedupedLogin({
				routerIP: session.routerIP,
				username: session.username,
				password: session.password
			});
			if (!newLogin.success) {
				return {
					...newLogin
				} as const;
			}
			sessionKey = newLogin.data.ubus_rpc_session;
		}

		return {
			success: true,
			data: { ...session, sessionKey }
		} as const;
	} catch (error) {
		return {
			success: false,
			ubusErrorMessage: 'Something went wrong while fetching the session.',
			error
		} as const;
	}
}

type SendUbusReturnType = Promise<
	| {
			success: true;
			data: {
				jsonrpc: string;
				id: number;
				result: [number, any];
			};
			rawResponse: object;
			call: object;
	  }
	| {
			success: false;
			ubusErrorMessage: string;
			call: object;
			error?: unknown;
			rawResponse?: object;
	  }
>;

// ---- Every HTTP request to a router goes through routerFetch() ----
// A router that is offline used to stall everything: requests had no timeout
// (each waited out the OS connect timeout), and the 1 s collector polls all
// routers together and skips ticks while one is still running - so one dead AP
// delayed or froze every chart. Now: a per-request timeout, and after a
// connection-level failure (unreachable / timed out - not a bad reply) the
// router is skipped instantly for a backoff that doubles from 15 s to 2 min;
// the first successful request clears it.
const ROUTER_TIMEOUT_MS = 8000;
const BACKOFF_MIN_MS = 15_000;
const BACKOFF_MAX_MS = 120_000;
const routerBackoff = new Map<string, { until: number; delay: number }>();

class RouterUnreachableError extends Error {}

async function routerFetch(routerIP: string, body: string): Promise<Response> {
	const now = Date.now();
	const backoff = routerBackoff.get(routerIP);
	if (backoff && now < backoff.until) {
		throw new RouterUnreachableError(
			`router ${routerIP} unreachable, retrying in ${Math.ceil((backoff.until - now) / 1000)}s`
		);
	}
	try {
		const response = await fetch(routerIP + '/ubus', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
			signal: AbortSignal.timeout(ROUTER_TIMEOUT_MS)
		});
		routerBackoff.delete(routerIP);
		return response;
	} catch (error) {
		const delay = Math.min(
			backoff ? backoff.delay * 2 : BACKOFF_MIN_MS,
			BACKOFF_MAX_MS
		);
		routerBackoff.set(routerIP, { until: Date.now() + delay, delay });
		throw error;
	}
}

// ---- Calls to one router issued together share one HTTP request ----
// Every call used to be its own POST /ubus. Calls (and batches) queued for the
// same router within BATCH_WINDOW_MS go out as one JSON-RPC batch - the
// collector issues a tick's calls for each router concurrently, so per tick a
// router gets one request instead of one per call (devstats every 1 s; plus
// iwinfo/hostapd per radio and macacct every 5 s). uhttpd runs the calls in
// order and answers with an array; ids are renumbered for the trip and each
// caller gets its own responses back with its own ids.
const BATCH_WINDOW_MS = 5;
type QueuedCalls = {
	calls: { id?: unknown }[];
	resolve: (responses: unknown[]) => void;
	reject: (error: unknown) => void;
};
const queuedCalls = new Map<string, QueuedCalls[]>();

function postUbus(routerIP: string, calls: { id?: unknown }[]): Promise<unknown[]> {
	return new Promise((resolve, reject) => {
		let queue = queuedCalls.get(routerIP);
		if (!queue) {
			queue = [];
			queuedCalls.set(routerIP, queue);
			setTimeout(() => flushUbus(routerIP), BATCH_WINDOW_MS);
		}
		queue.push({ calls, resolve, reject });
	});
}

async function flushUbus(routerIP: string) {
	const queue = queuedCalls.get(routerIP) ?? [];
	queuedCalls.delete(routerIP);
	const all = queue.flatMap((q) => q.calls);
	try {
		// A lone call goes out as a plain (non-batch) request, as before.
		const single = all.length === 1;
		const response = await routerFetch(
			routerIP,
			JSON.stringify(single ? all[0] : all.map((call, i) => ({ ...call, id: i })))
		);
		const json = await response.json();
		if (single) {
			queue[0].resolve([json]);
			return;
		}
		// Not an array: the whole batch was refused (e.g. a JSON-RPC error
		// object) - every call gets that answer, with its own id.
		const byId = new Map<unknown, unknown>(
			Array.isArray(json) ? json.map((r) => [r?.id, r]) : []
		);
		let i = 0;
		for (const q of queue) {
			q.resolve(
				q.calls.map((call) => {
					const r = Array.isArray(json) ? byId.get(i) : json;
					i++;
					return r && typeof r === 'object'
						? { ...r, id: call.id }
						: {
								jsonrpc: '2.0',
								id: call.id,
								error: { code: -32603, message: 'No response in batch' }
							};
				})
			);
		}
	} catch (error) {
		for (const q of queue) q.reject(error);
	}
}

async function sendUbus(
	routerIP: string,
	ubusObject: object
): SendUbusReturnType {
	try {
		const [jsonResponse] = (await postUbus(routerIP, [ubusObject])) as any[];
		const parsedResponse = validResponseSchema.safeParse(jsonResponse);
		if (!parsedResponse.success) {
			const accessDeniedCheck = accessDeniedSchema.safeParse(jsonResponse);
			if (accessDeniedCheck.success) {
				return {
					success: false,
					ubusErrorMessage: 'Access denied',
					rawResponse: jsonResponse,
					call: ubusObject
				};
			}
			return {
				success: false,
				ubusErrorMessage: 'Failed to parse ubus response',
				error: parsedResponse.error,
				rawResponse: jsonResponse,
				call: ubusObject
			};
		}
		return {
			success: true,
			data: parsedResponse.data,
			rawResponse: jsonResponse,
			call: ubusObject
		};
	} catch (error) {
		return {
			success: false,
			error,
			ubusErrorMessage:
				'Fetch request failed during call. Please check your router IP and make sure it is reachable',
			call: ubusObject
		};
	}
}

type UbusBatchResponses =
	| {
			success: true;
			jsonrpc: string;
			id: number;
			result: [number, any];
			rawResponse: object;
			call: object;
	  }
	| {
			success: false;
			jsonrpc: string;
			id: number;
			ubusErrorMessage: string;
			rawResponse: object;
			call: object;
	  };

type SendUbusBatchReturnType = Promise<
	| {
			success: true;
			data: UbusBatchResponses[];
			hasAccessDenied: boolean[];
	  }
	| {
			success: false;
			ubusErrorMessage: string;
			calls: object[];
			rawResponse?: object;
			error?: unknown;
			loginRawResponse?: object;
			loginCall?: object;
	  }
>;
async function sendUbusBatch(
	routerIP: string,
	calls: object[]
): SendUbusBatchReturnType {
	try {
		const jsonResponse = (await postUbus(routerIP, calls)) as any[];
		const parsedResponse = batchResponseSchema.safeParse(jsonResponse);
		if (!parsedResponse.success) {
			return {
				success: false,
				error: parsedResponse.error,
				ubusErrorMessage: 'Failed to parse ubus batch response',
				rawResponse: jsonResponse,
				calls: calls
			};
		}
		let hasAccessDenied: boolean[] = [];
		const filteredPrasedResponses = parsedResponse.data.map(
			(filteredParsedResponse) => {
				if (filteredParsedResponse.result) {
					hasAccessDenied.push(false);
					return {
						success: true,
						jsonrpc: filteredParsedResponse.jsonrpc,
						id: filteredParsedResponse.id,
						result: filteredParsedResponse.result,
						rawResponse: jsonResponse.find(
							(response: any) => response.id === filteredParsedResponse.id
						),
						call: calls.find(
							(call: any) => call.id === filteredParsedResponse.id
						) as object
					} as const;
				} else {
					const checkAccessDenied = accessDeniedSchema.safeParse(
						filteredParsedResponse
					);
					if (checkAccessDenied.success) {
						hasAccessDenied.push(true);
					}
					return {
						success: false,
						jsonrpc: filteredParsedResponse.jsonrpc,
						id: filteredParsedResponse.id,
						ubusErrorMessage: checkAccessDenied.success
							? 'Access denied'
							: 'Failed to parse ubus response',
						rawResponse: jsonResponse.find(
							(response: any) => response.id === filteredParsedResponse.id
						),
						call: calls.find(
							(call: any) => call.id === filteredParsedResponse.id
						) as object
					} as const;
				}
			}
		);
		return {
			success: true,
			data: filteredPrasedResponses,
			hasAccessDenied
		};
	} catch (error) {
		return {
			success: false,
			error,
			ubusErrorMessage:
				'Fetch request failed during batch call. Please check your router IP and make sure it is reachable',
			calls
		};
	}
}
