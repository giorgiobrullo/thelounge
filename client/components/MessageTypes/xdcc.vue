<template>
	<span v-if="message.xdcc" :class="['content', 'xdcc-offer', `xdcc-offer-${transferStatus}`]">
		<Username :user="message.from" /> offered
		<strong class="xdcc-file-name">{{ message.xdcc.fileName }}</strong>
		<span v-if="message.xdcc.size !== undefined" class="xdcc-file-size">
			({{ friendlysize(message.xdcc.size) }})
		</span>
		<span v-if="message.xdcc.secure" class="xdcc-file-security">(TLS)</span>
		<a
			v-if="canDownload"
			class="btn btn-sm xdcc-download"
			:href="message.xdcc.url"
			download
			:title="
				message.xdcc.secure
					? `This TLS connection does not verify the sender's identity and exposes this server's IP address`
					: `Downloads are unencrypted and expose this server's IP address to the sender`
			"
			>{{ transferStatus === "offered" ? "Download" : "Retry" }}</a
		>
		<span v-else :class="['xdcc-status', `xdcc-status-${transferStatus}`]" aria-live="polite">
			{{ statusLabel }}
		</span>
	</span>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import type {XdccTransferStatus} from "../../../shared/types/msg";
import friendlysize from "../../js/helpers/friendlysize";
import {useStore} from "../../js/store";
import type {ClientMessage, ClientNetwork} from "../../js/types";
import Username from "../Username.vue";

const downloadableStatuses = new Set<XdccTransferStatus>(["offered", "failed", "cancelled"]);
const statusLabels: Record<XdccTransferStatus, string> = {
	offered: "Available",
	connecting: "Connecting",
	transferring: "Downloading",
	completed: "Completed",
	failed: "Failed",
	cancelled: "Cancelled",
	expired: "Expired",
};

export default defineComponent({
	name: "MessageTypeXdcc",
	components: {
		Username,
	},
	props: {
		network: {
			type: Object as PropType<ClientNetwork>,
			required: true,
		},
		message: {
			type: Object as PropType<ClientMessage>,
			required: true,
		},
	},
	setup(props) {
		const store = useStore();
		const transferStatus = computed<XdccTransferStatus>(() => {
			const xdcc = props.message.xdcc;

			if (!xdcc) {
				return "expired";
			}

			const transfer = store.state.xdccTransfers.find((item) => item.id === xdcc.id);
			const status = transfer?.status ?? "expired";

			if (downloadableStatuses.has(status) && xdcc.expiresAt <= Date.now()) {
				return "expired";
			}

			return status;
		});
		const canDownload = computed(() => downloadableStatuses.has(transferStatus.value));
		const statusLabel = computed(() => statusLabels[transferStatus.value]);

		return {canDownload, friendlysize, statusLabel, transferStatus};
	},
});
</script>
