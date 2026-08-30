const PORT = process.env.PORT || '3000';
// Always connect via loopback - HOSTNAME is "0.0.0.0" (a bind address, not a
// valid connect target) in this image's Dockerfile, which made this
// intermittently fail with "fetch failed".
const METRICS_URL =
	process.env.METRICS_URL || `http://127.0.0.1:${PORT}/api/metrics/collect`;

async function collect() {
	try {
		const res = await fetch(METRICS_URL, { method: 'GET' });
		if (!res.ok) {
			console.error(
				`[metrics-cron] ${new Date().toISOString()} - fetch failed:`,
				res.status,
				res.statusText
			);
		}
	} catch (err) {
		console.error(
			'[metrics-cron] fetch error:',
			err && err.message ? err.message : err
		);
	}
}

const ONE_SECOND_MS = 1000;

setInterval(() => {
	collect();
}, ONE_SECOND_MS);

// Graceful shutdown
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
