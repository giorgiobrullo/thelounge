import Config from "../../config";
import Msg from "../../models/msg";
import {MessageType} from "../../../shared/types/msg";
import {PluginInputHandler} from "./index";

const commands = ["xdcc"];

const input: PluginInputHandler = function (network, chan, _cmd, args) {
	if (!Config.values.xdcc.enable) {
		chan.pushMessage(
			this,
			new Msg({
				type: MessageType.ERROR,
				text: "XDCC downloads are disabled by the server administrator.",
			})
		);
		return;
	}

	const secure = args[2]?.toLowerCase() === "tls";

	if (
		(args.length !== 2 && args.length !== 3) ||
		!/^#?\d+$/.test(args[1]) ||
		(args[2] && !secure)
	) {
		chan.pushMessage(
			this,
			new Msg({
				type: MessageType.ERROR,
				text: "Usage: /xdcc <bot> <pack number> [tls]",
			})
		);
		return;
	}

	const target = args[0];
	const pack = args[1].replace(/^#/, "");
	const command = secure ? "SSEND" : "SEND";
	network.irc.say(target, `XDCC ${command} #${pack}`);
	chan.pushMessage(
		this,
		new Msg({
			type: MessageType.NOTE,
			text: `Requested ${secure ? "TLS " : ""}XDCC pack #${pack} from ${target}.`,
		})
	);
};

export default {
	commands,
	input,
};
