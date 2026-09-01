import {expect} from "vitest";
import express from "express";
import http from "http";
import net from "net";
import tls from "tls";
import {md, pki} from "node-forge";

import Config from "../../server/config";
import Xdcc, {isBlockedAddress, parseDccSend} from "../../server/plugins/xdcc";

describe("XDCC", function () {
	const originalConfig = {...Config.values.xdcc};

	afterEach(function () {
		Object.assign(Config.values.xdcc, originalConfig);
	});

	it("parses quoted names and legacy integer IPv4 addresses", function () {
		expect(parseDccSend('DCC SEND "example file.bin" 2130706433 5000 1234')).to.deep.equal({
			fileName: "example file.bin",
			address: "127.0.0.1",
			port: 5000,
			size: 1234,
			secure: false,
			turbo: false,
		});
	});

	it("parses escaped quotes and secure turbo variants", function () {
		expect(parseDccSend('DCC TSSEND "example \\"file.bin" 1.1.1.1 5000 1234')).to.deep.equal({
			fileName: 'example "file.bin',
			address: "1.1.1.1",
			port: 5000,
			size: 1234,
			secure: true,
			turbo: true,
		});
	});

	it("canonicalizes IP literals and rejects ambiguous address formats", function () {
		expect(
			parseDccSend("DCC SEND test.bin 2606:4700:4700:0000:0000:0000:0000:1111 5000 12")
				?.address
		).to.equal("2606:4700:4700::1111");

		for (const address of [
			"127.0.0.1/8",
			"127.0.0.1%lo0",
			"127.1",
			"0177.0.0.1",
			"0x7f000001",
			"::1/128",
			"fe80::1%lo0",
		]) {
			expect(parseDccSend(`DCC SEND test.bin ${address} 5000 12`), address).to.equal(
				undefined
			);
		}
	});

	it("removes path components from offered file names", function () {
		expect(parseDccSend("DCC SEND ../../example.bin 203.0.113.1 5000 12")?.fileName).to.equal(
			"example.bin"
		);
	});

	it("blocks non-global and special-purpose addresses", function () {
		for (const address of [
			"not-an-ip",
			"0.1.2.3",
			"10.0.0.1",
			"100.64.0.1",
			"127.0.0.1",
			"169.254.169.254",
			"172.16.0.1",
			"192.0.0.170",
			"192.0.2.1",
			"192.168.1.1",
			"198.18.0.1",
			"198.51.100.1",
			"203.0.113.1",
			"224.0.0.1",
			"240.0.0.1",
			"255.255.255.255",
			"::",
			"::1",
			"::ffff:127.0.0.1",
			"0:0:0:0:0:ffff:7f00:1",
			"64:ff9b::7f00:1",
			"64:ff9b:1::1",
			"100::1",
			"100:0:0:1::1",
			"2001:2::1",
			"2001:db8::1",
			"2002:0808:0808::1",
			"3fff::1",
			"5f00::1",
			"fc00::1",
			"fe80::1",
			"ff00::1",
			"4000::1",
		]) {
			expect(isBlockedAddress(address), address).to.equal(true);
		}
	});

	it("allows globally reachable addresses and embedded public IPv4", function () {
		for (const address of [
			"1.1.1.1",
			"192.0.0.9",
			"2606:4700:4700::1111",
			"64:ff9b::0808:0808",
		]) {
			expect(isBlockedAddress(address), address).to.equal(false);
		}
	});

	it("keeps cloud control-plane addresses blocked when private networks are allowed", function () {
		expect(isBlockedAddress("127.0.0.1", true)).to.equal(false);
		expect(isBlockedAddress("fc00::1", true)).to.equal(false);

		for (const address of [
			"100.100.100.200",
			"168.63.129.16",
			"169.254.169.254",
			"169.254.170.2",
			"fd00:ec2::254",
			"::ffff:169.254.169.254",
			"64:ff9b::a9fe:a9fe",
		]) {
			expect(isBlockedAddress(address, true), address).to.equal(true);
		}
	});

	it("blocks offers to restricted ports", function () {
		Config.values.xdcc.enable = true;
		Config.values.xdcc.allowPrivateAddresses = true;
		Config.values.xdcc.minPort = 1024;

		expect(Xdcc.registerOffer("DCC SEND test.bin 1.1.1.1 80 12")?.error).to.equal(
			"Blocked an XDCC offer to a restricted TCP port."
		);
	});

	it("rechecks the address policy immediately before connecting", async function () {
		Config.values.xdcc.enable = true;
		Config.values.xdcc.allowPrivateAddresses = true;
		const registration = Xdcc.registerOffer("DCC SEND test.bin 2130706433 5000 12");

		if (!registration?.offer) {
			throw new Error(registration?.error || "DCC offer was not registered");
		}

		Config.values.xdcc.allowPrivateAddresses = false;
		const app = express();
		Xdcc.router(app);
		const webServer = http.createServer(app);
		await new Promise<void>((resolve) => webServer.listen(0, "127.0.0.1", resolve));
		const webAddress = webServer.address();

		if (!webAddress || typeof webAddress === "string") {
			throw new Error("XDCC web test server did not bind to a TCP port");
		}

		try {
			const response = await fetch(
				`http://127.0.0.1:${webAddress.port}/${registration.offer.url}`
			);

			expect(response.status).to.equal(403);
			expect(await response.text()).to.equal("This XDCC address is not allowed");
		} finally {
			await new Promise<void>((resolve) => webServer.close(() => resolve()));
		}
	});

	it("streams a download and acknowledges the received byte count", async function () {
		Config.values.xdcc.enable = true;
		Config.values.xdcc.allowPrivateAddresses = true;
		const payload = Buffer.from("hello XDCC");
		let resolveAcknowledgement!: (value: number) => void;
		const acknowledgement = new Promise<number>((resolve) => {
			resolveAcknowledgement = resolve;
		});
		const dccServer = net.createServer((socket) => {
			socket.write(payload);
			socket.once("data", (data) => {
				resolveAcknowledgement(data.readUInt32BE(0));
				socket.end();
			});
		});

		await new Promise<void>((resolve) => dccServer.listen(0, "127.0.0.1", resolve));
		const dccAddress = dccServer.address();

		if (!dccAddress || typeof dccAddress === "string") {
			throw new Error("DCC test server did not bind to a TCP port");
		}

		const registration = Xdcc.registerOffer(
			`DCC SEND test.bin 2130706433 ${dccAddress.port} ${payload.length}`
		);

		if (!registration?.offer) {
			throw new Error(registration?.error || "DCC offer was not registered");
		}

		const app = express();
		Xdcc.router(app);
		const webServer = http.createServer(app);
		await new Promise<void>((resolve) => webServer.listen(0, "127.0.0.1", resolve));
		const webAddress = webServer.address();

		if (!webAddress || typeof webAddress === "string") {
			throw new Error("XDCC web test server did not bind to a TCP port");
		}

		try {
			const response = await fetch(
				`http://127.0.0.1:${webAddress.port}/${registration.offer.url}`
			);
			const body = Buffer.from(await response.arrayBuffer());

			expect(response.status).to.equal(200);
			expect(response.headers.get("content-disposition")).to.contain("test.bin");
			expect(body).to.deep.equal(payload);
			expect(await acknowledgement).to.equal(payload.length);
		} finally {
			await Promise.all([
				new Promise<void>((resolve) => dccServer.close(() => resolve())),
				new Promise<void>((resolve) => webServer.close(() => resolve())),
			]);
		}
	});

	it("streams a TLS-encrypted transfer", async function () {
		Config.values.xdcc.enable = true;
		Config.values.xdcc.allowPrivateAddresses = true;
		const payload = Buffer.from("hello secure XDCC");
		const keys = pki.rsa.generateKeyPair(2048);
		const certificate = pki.createCertificate();
		certificate.publicKey = keys.publicKey;
		certificate.serialNumber = "01";
		certificate.validity.notBefore = new Date(Date.now() - 60_000);
		certificate.validity.notAfter = new Date(Date.now() + 60_000);
		certificate.setSubject([{name: "commonName", value: "localhost"}]);
		certificate.setIssuer(certificate.subject.attributes);
		certificate.sign(keys.privateKey, md.sha256.create());
		let resolveAcknowledgement!: (value: number) => void;
		const acknowledgement = new Promise<number>((resolve) => {
			resolveAcknowledgement = resolve;
		});
		const dccServer = tls.createServer(
			{
				key: pki.privateKeyToPem(keys.privateKey),
				cert: pki.certificateToPem(certificate),
			},
			(socket) => {
				socket.write(payload);
				socket.once("data", (data) => {
					resolveAcknowledgement(data.readUInt32BE(0));
					socket.end();
				});
			}
		);

		await new Promise<void>((resolve) => dccServer.listen(0, "127.0.0.1", resolve));
		const dccAddress = dccServer.address();

		if (!dccAddress || typeof dccAddress === "string") {
			throw new Error("TLS XDCC test server did not bind to a TCP port");
		}

		const registration = Xdcc.registerOffer(
			`DCC SSEND secure.bin 2130706433 ${dccAddress.port} ${payload.length}`
		);

		if (!registration?.offer) {
			throw new Error(registration?.error || "Secure DCC offer was not registered");
		}

		const app = express();
		Xdcc.router(app);
		const webServer = http.createServer(app);
		await new Promise<void>((resolve) => webServer.listen(0, "127.0.0.1", resolve));
		const webAddress = webServer.address();

		if (!webAddress || typeof webAddress === "string") {
			throw new Error("XDCC web test server did not bind to a TCP port");
		}

		try {
			const response = await fetch(
				`http://127.0.0.1:${webAddress.port}/${registration.offer.url}`
			);
			const body = Buffer.from(await response.arrayBuffer());

			expect(response.status).to.equal(200);
			expect(body).to.deep.equal(payload);
			expect(await acknowledgement).to.equal(payload.length);
		} finally {
			await Promise.all([
				new Promise<void>((resolve) => dccServer.close(() => resolve())),
				new Promise<void>((resolve) => webServer.close(() => resolve())),
			]);
		}
	});
});
