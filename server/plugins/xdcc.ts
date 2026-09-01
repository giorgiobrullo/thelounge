import contentDisposition from "content-disposition";
import crypto from "crypto";
import type {Application, Request, Response} from "express";
import net from "net";

import Config from "../config";
import type {XdccFile} from "../../shared/types/msg";

type DccSend = {
	fileName: string;
	address: string;
	port: number;
	size?: number;
};

type StoredOffer = DccSend & {
	expiresAt: number;
	timeout: ReturnType<typeof setTimeout>;
};

export type XdccRegistration = {offer: XdccFile; error?: never} | {offer?: never; error: string};

const offers = new Map<string, StoredOffer>();
let activeDownloads = 0;

const blockedAddresses = new net.BlockList();

for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	blockedAddresses.addSubnet(address, prefix, "ipv4");
}

for (const [address, prefix] of [
	["::", 128],
	["::1", 128],
	["100::", 64],
	["2001:db8::", 32],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const) {
	blockedAddresses.addSubnet(address, prefix, "ipv6");
}

function parseAddress(value: string): string | undefined {
	if (/^\d+$/.test(value)) {
		try {
			const numericAddress = BigInt(value);

			if (numericAddress < 0n || numericAddress > 0xffffffffn) {
				return undefined;
			}

			return [24n, 16n, 8n, 0n]
				.map((shift) => Number((numericAddress >> shift) & 0xffn))
				.join(".");
		} catch {
			return undefined;
		}
	}

	return net.isIP(value) ? value : undefined;
}

function cleanFileName(value: string): string | undefined {
	const fileName = value
		.replace(/\\/g, "/")
		.split("/")
		.pop()!
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.trim();

	if (!fileName || fileName === "." || fileName === ".." || fileName.length > 255) {
		return undefined;
	}

	return fileName;
}

export function parseDccSend(message: string): DccSend | undefined {
	const match = message.match(
		/^DCC\s+SEND\s+(?:"([^"]+)"|(\S+))\s+(\S+)\s+(\d+)(?:\s+(\d+))?(?:\s+\S+)?\s*$/i
	);

	if (!match) {
		return undefined;
	}

	const fileName = cleanFileName(match[1] || match[2]);
	const address = parseAddress(match[3]);
	const port = Number(match[4]);
	const size = match[5] === undefined ? undefined : Number(match[5]);

	if (
		!fileName ||
		!address ||
		!Number.isInteger(port) ||
		port < 0 ||
		port > 65535 ||
		(size !== undefined && (!Number.isSafeInteger(size) || size < 0))
	) {
		return undefined;
	}

	return {fileName, address, port, size};
}

export function isBlockedAddress(address: string): boolean {
	if (/^::ffff:/i.test(address)) {
		return true;
	}

	const family = net.isIPv6(address) ? "ipv6" : "ipv4";
	return blockedAddresses.check(address, family);
}

function getMaxFileSize(): number {
	const configuredSize = Config.values.xdcc.maxFileSize;
	return configuredSize < 0 ? Infinity : configuredSize * 1024;
}

function registerOffer(message: string): XdccRegistration | undefined {
	if (!/^DCC\s+SEND\b/i.test(message)) {
		return undefined;
	}

	if (!Config.values.xdcc.enable) {
		return {error: "XDCC downloads are disabled by the server administrator."};
	}

	const parsed = parseDccSend(message);

	if (!parsed) {
		return {error: "Received a malformed DCC SEND offer."};
	}

	if (parsed.port === 0) {
		return {error: "Reverse DCC SEND offers are not supported."};
	}

	if (!Config.values.xdcc.allowPrivateAddresses && isBlockedAddress(parsed.address)) {
		return {error: "Blocked an XDCC offer to a private or reserved address."};
	}

	const maxFileSize = getMaxFileSize();

	if (parsed.size !== undefined && parsed.size > maxFileSize) {
		return {error: "The offered XDCC file exceeds the configured size limit."};
	}

	const token = crypto.randomUUID();
	const expiresAt = Date.now() + Config.values.xdcc.offerTimeout;
	const timeout = setTimeout(() => offers.delete(token), Config.values.xdcc.offerTimeout);
	timeout.unref();
	offers.set(token, {...parsed, expiresAt, timeout});

	return {
		offer: {
			fileName: parsed.fileName,
			size: parsed.size,
			url: `xdcc/${token}/${encodeURIComponent(parsed.fileName)}`,
			expiresAt,
		},
	};
}

function claimOffer(token: string): StoredOffer | undefined {
	const offer = offers.get(token);

	if (!offer || offer.expiresAt <= Date.now()) {
		if (offer) {
			clearTimeout(offer.timeout);
			offers.delete(token);
		}

		return undefined;
	}

	clearTimeout(offer.timeout);
	offers.delete(token);
	return offer;
}

function routeDownload(req: Request, res: Response): Response | void {
	if (!Config.values.xdcc.enable) {
		return res.status(404).send("Not found");
	}

	if (!/^[0-9a-f-]{36}$/i.test(req.params.token)) {
		return res.status(404).send("Not found");
	}

	if (activeDownloads >= Config.values.xdcc.maxConcurrentDownloads) {
		return res.status(429).send("Too many XDCC downloads are already active");
	}

	const offer = claimOffer(req.params.token);

	if (!offer) {
		return res.status(404).send("This XDCC offer is invalid or has expired");
	}

	if (!Config.values.xdcc.allowPrivateAddresses && isBlockedAddress(offer.address)) {
		return res.status(403).send("This XDCC address is not allowed");
	}

	activeDownloads++;
	let received = 0;
	let finished = false;
	let upstreamEnded = false;
	const maxFileSize = getMaxFileSize();
	const source = net.createConnection({
		host: offer.address,
		port: offer.port,
		localAddress: Config.values.bind,
	});

	const cleanup = () => {
		if (finished) {
			return;
		}

		finished = true;
		activeDownloads--;
		source.destroy();
	};

	const fail = (status: number, message: string) => {
		if (finished) {
			return;
		}

		if (!res.headersSent) {
			res.status(status).send(message);
		} else {
			res.destroy(Error(message));
		}

		cleanup();
	};

	source.setNoDelay(true);
	source.setTimeout(Config.values.xdcc.timeout);

	source.once("connect", () => {
		res.setHeader(
			"Content-Disposition",
			contentDisposition(offer.fileName, {type: "attachment", fallback: false})
		);
		res.setHeader("Content-Type", "application/octet-stream");
		res.setHeader("Cache-Control", "no-store");

		if (offer.size !== undefined) {
			res.setHeader("Content-Length", offer.size.toString());
		}

		res.flushHeaders();
	});

	source.on("data", (chunk: Buffer) => {
		received += chunk.length;

		if (received > maxFileSize || (offer.size !== undefined && received > offer.size)) {
			fail(502, "The XDCC sender exceeded the advertised file size");
			return;
		}

		const canContinue = res.write(chunk);
		const acknowledgement = Buffer.allocUnsafe(4);
		acknowledgement.writeUInt32BE(received % 0x100000000);
		source.write(acknowledgement);

		if (!canContinue) {
			source.pause();
			res.once("drain", () => source.resume());
		}
	});

	source.once("end", () => {
		upstreamEnded = true;

		if (offer.size !== undefined && received !== offer.size) {
			fail(502, "The XDCC sender closed the connection before the file was complete");
			return;
		}

		res.end();
		cleanup();
	});

	source.once("timeout", () => fail(504, "The XDCC sender timed out"));
	source.once("error", () => fail(502, "Could not connect to the XDCC sender"));
	source.once("close", (hadError) => {
		if (!finished && !upstreamEnded && !hadError) {
			fail(502, "The XDCC sender closed the connection unexpectedly");
		}
	});

	res.once("close", () => {
		if (!res.writableEnded) {
			cleanup();
		}
	});
}

export default {
	registerOffer,
	router(app: Application) {
		app.get("/xdcc/:token/:slug?", routeDownload);
	},
};
