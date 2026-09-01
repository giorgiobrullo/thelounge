import contentDisposition from "content-disposition";
import crypto from "crypto";
import type {Application, Request, Response} from "express";
import net from "net";
import tls from "tls";

import Config from "../config";
import type {XdccFile} from "../../shared/types/msg";

type DccSend = {
	fileName: string;
	address: string;
	port: number;
	size?: number;
	secure: boolean;
	turbo: boolean;
};

type StoredOffer = DccSend & {
	expiresAt: number;
	timeout: ReturnType<typeof setTimeout>;
};

export type XdccRegistration = {offer: XdccFile; error?: never} | {offer?: never; error: string};

const offers = new Map<string, StoredOffer>();
let activeDownloads = 0;

const blockedIpv4Addresses = new net.BlockList();
const blockedIpv6Addresses = new net.BlockList();

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
	blockedIpv4Addresses.addSubnet(address, prefix, "ipv4");
}

for (const [address, prefix] of [
	["::", 96],
	["::ffff:0:0", 96],
	["100::", 64],
	["64:ff9b::", 96],
	["64:ff9b:1::", 48],
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const) {
	blockedIpv6Addresses.addSubnet(address, prefix, "ipv6");
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

function parseArguments(value: string): {fileName: string; args: string[]} | undefined {
	const quoted = value.match(/^"((?:\\.|[^"\\])*)"\s+(.+)$/);
	const unquoted = value.match(/^(\S+)\s+(.+)$/);
	const match = quoted || unquoted;

	if (!match) {
		return undefined;
	}

	const rawFileName = quoted ? match[1].replace(/\\(["\\])/g, "$1") : match[1];
	const remainder = match[2];

	const fileName = cleanFileName(rawFileName);
	const args = remainder.split(/\s+/);

	return fileName ? {fileName, args} : undefined;
}

export function parseDccSend(message: string): DccSend | undefined {
	const match = message.match(/^DCC\s+(SEND|TSEND|SSEND|TSSEND|STSEND)\s+(.+?)\s*$/i);

	if (!match) {
		return undefined;
	}

	const parsed = parseArguments(match[2]);

	if (!parsed || parsed.args.length < 2 || parsed.args.length > 4) {
		return undefined;
	}

	const address = parseAddress(parsed.args[0]);
	const port = Number(parsed.args[1]);
	const size = parsed.args[2] === undefined ? undefined : Number(parsed.args[2]);
	const reverseToken = parsed.args[3];
	const flags = match[1].slice(0, -4).toUpperCase();

	if (
		!address ||
		!/^[0-9]+$/.test(parsed.args[1]) ||
		!Number.isInteger(port) ||
		port < 0 ||
		port > 65535 ||
		(size !== undefined &&
			(!/^[0-9]+$/.test(parsed.args[2]) || !Number.isSafeInteger(size) || size < 0)) ||
		(reverseToken !== undefined && !/^[0-9]+$/.test(reverseToken))
	) {
		return undefined;
	}

	return {
		fileName: parsed.fileName,
		address,
		port,
		size,
		secure: flags.includes("S"),
		turbo: flags.includes("T"),
	};
}

export function isBlockedAddress(address: string): boolean {
	return net.isIPv6(address)
		? blockedIpv6Addresses.check(address, "ipv6")
		: blockedIpv4Addresses.check(address, "ipv4");
}

function getMaxFileSize(): number {
	const configuredSize = Config.values.xdcc.maxFileSize;
	return configuredSize < 0 ? Infinity : configuredSize * 1024;
}

function registerOffer(message: string): XdccRegistration | undefined {
	if (!/^DCC\s+(?:SEND|TSEND|SSEND|TSSEND|STSEND)\b/i.test(message)) {
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

	if (parsed.port < Config.values.xdcc.minPort) {
		return {error: "Blocked an XDCC offer to a restricted TCP port."};
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
			secure: parsed.secure,
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

	if (offer.port < Config.values.xdcc.minPort) {
		return res.status(403).send("This XDCC port is not allowed");
	}

	activeDownloads++;
	let received = 0;
	let finished = false;
	let upstreamEnded = false;
	const maxFileSize = getMaxFileSize();
	const connectionOptions = {
		host: offer.address,
		port: offer.port,
		localAddress: Config.values.bind,
	};
	const source = offer.secure
		? tls.connect({...connectionOptions, rejectUnauthorized: false})
		: net.createConnection(connectionOptions);

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

	source.once(offer.secure ? "secureConnect" : "connect", () => {
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

		if (!offer.turbo || (offer.size !== undefined && received === offer.size)) {
			const acknowledgement = Buffer.allocUnsafe(4);
			acknowledgement.writeUInt32BE(received % 0x100000000);
			source.write(acknowledgement);
		}

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
