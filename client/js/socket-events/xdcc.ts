import socket from "../socket";
import {store} from "../store";

socket.on("xdcc:list", (transfers) => {
	store.commit("setXdccTransfers", transfers);
});

socket.on("xdcc:update", (update) => {
	store.commit("updateXdccTransfer", update);
});
