import 'server-only';
import { gzipSync } from 'node:zlib';
import { headers } from 'next/headers';

// Next compresses its own pages but not what route handlers return, so every
// API response used to go out as plain JSON - the charts' 5 s polls were most
// of the dashboard's traffic. Chart JSON is very repetitive and gzips 6-12x.
// Browsers only offer br over HTTPS, so gzip is what plain http://devnull:3000
// gets. Tiny bodies aren't worth the header.
const MIN_GZIP_BYTES = 1024;

export async function jsonResponse(body: unknown, status = 200) {
	const json = JSON.stringify(body);
	const responseHeaders: Record<string, string> = {
		'Content-Type': 'application/json',
		Vary: 'Accept-Encoding'
	};
	const acceptEncoding = (await headers()).get('accept-encoding') ?? '';
	if (json.length >= MIN_GZIP_BYTES && /\bgzip\b/.test(acceptEncoding)) {
		responseHeaders['Content-Encoding'] = 'gzip';
		return new Response(gzipSync(json), { status, headers: responseHeaders });
	}
	return new Response(json, { status, headers: responseHeaders });
}
