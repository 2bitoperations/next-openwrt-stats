import util from 'util';

// An unreachable router produces the same error from every poll (several per
// second across all callers); print each distinct (router, message) at most
// once a minute, with a count of what was suppressed.
const LOG_REPEAT_MS = 60_000;
const lastLogged = new Map<string, { at: number; suppressed: number }>();

export function logError(error: { [key: string]: any }) {
	const key = `${error.displayName ?? ''}|${error.errorMessage ?? ''}|${error.ubusErrorMessage ?? ''}`;
	const now = Date.now();
	const prev = lastLogged.get(key);
	if (prev && now - prev.at < LOG_REPEAT_MS) {
		prev.suppressed++;
		return;
	}
	lastLogged.set(key, { at: now, suppressed: 0 });
	if (prev?.suppressed) error = { ...error, suppressedRepeats: prev.suppressed };
	console.log(
		util.inspect(
			{
				timestamp: new Date().toISOString(),
				...error
			},
			{ depth: null, colors: true }
		)
	);
}
