import {EventEmitter} from "events";
import {expect} from "vitest";
import sinon from "ts-sinon";

import ctcpEvent from "../../../server/plugins/irc-events/ctcp";
import {MessageType} from "../../../shared/types/msg";

function createHarness() {
	const irc = Object.assign(new EventEmitter(), {
		user: {nick: "LoungeUser"},
		network: {cap: {isEnabled: () => false}},
		ctcpResponse: sinon.stub(),
	});
	const pushMessage = sinon.stub();
	const network = {
		getLobby: () => ({pushMessage}),
		isIgnoredUser: () => false,
	};

	ctcpEvent.call({} as any, irc as any, network as any);

	return {irc, pushMessage};
}

function emitDccOffer(irc: EventEmitter & {user: {nick: string}}, target: string) {
	irc.emit("ctcp request", {
		from_server: false,
		nick: "SomeBot",
		ident: "bot",
		hostname: "example.test",
		target,
		type: "DCC",
		message: "DCC SEND test.bin 16843009 5000 12",
		time: new Date(),
	});
}

describe("CTCP event", function () {
	it("turns direct DCC SEND requests into downloadable offers", function () {
		const {irc, pushMessage} = createHarness();

		emitDccOffer(irc, "loungeuser");

		expect(pushMessage.firstCall.args[1].type).to.equal(MessageType.XDCC);
		expect(pushMessage.firstCall.args[1].xdcc.fileName).to.equal("test.bin");
		expect(pushMessage.firstCall.args[1].showInActive).to.equal(true);
	});

	it("does not make channel-targeted DCC SEND requests actionable", function () {
		const {irc, pushMessage} = createHarness();

		emitDccOffer(irc, "#channel");

		expect(pushMessage.firstCall.args[1].type).to.equal(MessageType.CTCP_REQUEST);
		expect(pushMessage.firstCall.args[1].xdcc).to.equal(undefined);
	});
});
