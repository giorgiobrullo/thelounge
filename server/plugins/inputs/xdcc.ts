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

	if (args.length !== 2 || !/^#?\d+$/.test(args[1])) {
		chan.pushMessage(
			this,
			new Msg({
				type: MessageType.ERROR,
				text: "Usage: /xdcc <bot> <pack number>",
			})
		);
		return;
	}

	const target = args[0];
	const pack = args[1].replace(/^#/, "");
	network.irc.say(target, `XDCC SEND #${pack}`);
	chan.pushMessage(
		this,
		new Msg({
			type: MessageType.NOTE,
			text: `Requested XDCC pack #${pack} from ${target}.`,
		})
	);
};

export default {
	commands,
	input,
};
