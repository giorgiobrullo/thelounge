<template>
	<div id="changelog" class="window" aria-label="Changelog">
		<div class="header">
			<SidebarToggle />
		</div>
		<div class="container">
			<router-link id="back-to-help" to="/help">« Help</router-link>

			<template v-if="store.state.versionData?.current?.commit">
				<h1 class="title">
					Current commit: {{ store.state.versionData.current.commit }}
				</h1>

				<p>
					<a
						:href="store.state.versionData.current.url"
						target="_blank"
						rel="noopener"
						>View this commit on GitHub</a
					>
				</p>

				<template v-if="store.state.versionData?.latest">
					<h3>Update available</h3>
					<p>
						A newer commit
						<code>{{ store.state.versionData.latest.commit }}</code>
						is available.
					</p>
					<p>
						<a
							:href="store.state.versionData.latest.url"
							target="_blank"
							rel="noopener"
							>See what changed on GitHub</a
						>
					</p>
				</template>
				<template v-else>
					<p>You are running the latest commit.</p>
				</template>
			</template>
			<p v-else>Loading version info…</p>
		</div>
	</div>
</template>

<script lang="ts">
import {defineComponent, onMounted} from "vue";
import socket from "../../js/socket";
import {useStore} from "../../js/store";
import SidebarToggle from "../SidebarToggle.vue";

export default defineComponent({
	name: "Changelog",
	components: {
		SidebarToggle,
	},
	setup() {
		const store = useStore();

		onMounted(() => {
			if (!store.state.versionData) {
				socket.emit("changelog");
			}
		});

		return {
			store,
		};
	},
});
</script>
