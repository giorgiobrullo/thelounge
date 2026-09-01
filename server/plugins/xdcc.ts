import contentDisposition from "content-disposition";
import crypto from "crypto";
import type {Application, Request, Response} from "express";
import {Address4, Address6} from "ip-address";
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

// Some cloud providers expose metadata or control-plane services at fixed IPs.
// Keep them unreachable even when private-network downloads are explicitly enabled.
const blockedControlPlaneAddresses = new Set([
	"100.100.100.200",
	"168.63.129.16",
	"169.254.169.254",
	"169.254.170.2",
	"fd00:ec2::254",
]);

function parseIpLiteral(value: string): Address4 | Address6 | undefined {
	try {
		if (value.includes(":")) {
			const address = new Address6(value);

			return address.parsedSubnet || address.zone ? undefined : address;
		}

		const address = new Address4(value);
		return address.parsedSubnet ? undefined : address;
	} catch {
		return undefined;
	}
}

function isBlockedControlPlaneAddress(address: Address4 | Address6): boolean {
	if (blockedControlPlaneAddresses.has(address.correctForm())) {
		return true;
	}

	const embeddedIpv4 = address instanceof Address6 ? address.embeddedIPv4() : null;

	return embeddedIpv4 !== null && blockedControlPlaneAddresses.has(embeddedIpv4.correctForm());
}

function parseAddress(value: string): string | undefined {
	if (/^\d+$/.test(value)) {
		try {
			const numericAddress = BigInt(value);

			if (numericAddress < 0n || numericAddress > 0xffffffffn) {
				return undefined;
			}

			return Address4.fromBigInt(numericAddress).correctForm();
		} catch {
			return undefined;
		}
	}

	return parseIpLiteral(value)?.correctForm();
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

export function isBlockedAddress(address: string, allowPrivateAddresses = false): boolean {
	const parsed = parseIpLiteral(address);

	if (!parsed) {
		return true;
	}

	return isBlockedControlPlaneAddress(parsed) || (!allowPrivateAddresses && !parsed.isGlobal());
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

	if (isBlockedAddress(parsed.address, Config.values.xdcc.allowPrivateAddresses)) {
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

	if (isBlockedAddress(offer.address, Config.values.xdcc.allowPrivateAddresses)) {
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

	const validateConnectedAddress = () => {
		const remoteAddress = source.remoteAddress;

		if (
			!remoteAddress ||
			isBlockedAddress(remoteAddress, Config.values.xdcc.allowPrivateAddresses)
		) {
			fail(403, "The connected XDCC address is not allowed");
			return false;
		}

		return true;
	};

	if (offer.secure) {
		source.once("connect", validateConnectedAddress);
	}

	source.once(offer.secure ? "secureConnect" : "connect", () => {
		if (!validateConnectedAddress()) {
			return;
		}

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
