<template>
	<span v-if="message.xdcc" class="content xdcc-offer">
		<Username :user="message.from" /> offered
		<strong class="xdcc-file-name">{{ message.xdcc.fileName }}</strong>
		<span v-if="message.xdcc.size !== undefined" class="xdcc-file-size">
			({{ friendlysize(message.xdcc.size) }})
		</span>
		<span v-if="message.xdcc.secure" class="xdcc-file-security">(TLS)</span>
		<a
			class="btn btn-sm xdcc-download"
			:href="message.xdcc.url"
			download
			:title="
				message.xdcc.secure
					? `This TLS connection does not verify the sender's identity and exposes this server's IP address`
					: `Downloads are unencrypted and expose this server's IP address to the sender`
			"
			>Download</a
		>
	</span>
</template>

<script lang="ts">
import {defineComponent, PropType} from "vue";
import friendlysize from "../../js/helpers/friendlysize";
import type {ClientMessage, ClientNetwork} from "../../js/types";
import Username from "../Username.vue";

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
	setup() {
		return {friendlysize};
	},
});
</script>
