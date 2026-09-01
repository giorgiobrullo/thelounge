<template>
	<div id="transfers" class="window" role="tabpanel" aria-label="Transfers">
		<div class="header">
			<SidebarToggle />
		</div>

		<div class="container transfers-container">
			<section class="setting-card transfers-card" aria-labelledby="transfers-title">
				<h2 id="transfers-title" class="setting-card-title">Transfers</h2>
				<p class="setting-card-intro">Download and manage files offered by XDCC bots.</p>

				<div v-if="transfers.length" class="transfers-summary" aria-live="polite">
					<p>
						<strong>{{ activeCount }}</strong>
						{{ activeCount === 1 ? "active transfer" : "active transfers" }}
						<span aria-hidden="true"> · </span>
						<strong>{{ transfers.length }}</strong> total
					</p>
					<button v-if="hasFinishedTransfers" class="btn btn-sm" @click="clearFinished">
						Clear finished
					</button>
				</div>

				<div v-if="transfers.length === 0" class="transfers-empty">
					<span class="transfers-empty-icon" aria-hidden="true" />
					<div>
						<strong>No transfers yet</strong>
						<p>
							Request a pack with <code>/xdcc bot pack</code>. Incoming offers will
							appear here and in chat.
						</p>
					</div>
				</div>

				<ul v-else class="transfer-list">
					<li
						v-for="transfer in transfers"
						:key="transfer.id"
						:class="['transfer-item', `transfer-item-${transfer.status}`]"
					>
						<span
							:class="[
								'transfer-file-icon',
								`transfer-file-icon-${fileTypeIcon(transfer.fileName)}`,
							]"
							aria-hidden="true"
						/>

						<div class="transfer-details">
							<div class="transfer-heading">
								<strong class="transfer-file-name">{{ transfer.fileName }}</strong>
							</div>

							<div class="transfer-meta">
								<span>{{ transfer.sender }}</span>
								<template v-if="transfer.network">
									<span aria-hidden="true"> · </span>
									<span>{{ transfer.network }}</span>
								</template>
								<span
									v-if="transfer.secure"
									class="transfer-tls"
									title="Encrypted with TLS"
								>
									TLS
								</span>
								<span aria-hidden="true"> · </span>
								<time :datetime="new Date(transfer.offeredAt).toISOString()">
									{{ formatTime(transfer.offeredAt) }}
								</time>
							</div>

							<progress
								v-if="showProgress(transfer)"
								class="transfer-progress"
								:max="transfer.size || 1"
								:value="progressValue(transfer)"
								:aria-label="`${transfer.fileName} download progress`"
							/>

							<div
								:class="[
									'transfer-status-detail',
									{error: transfer.status === 'failed'},
								]"
							>
								{{ statusDetail(transfer) }}
							</div>
						</div>

						<div class="transfer-actions">
							<span
								:class="['transfer-state', `transfer-state-${transfer.status}`]"
								aria-live="polite"
							>
								{{ statusLabel(transfer) }}
							</span>
							<a
								v-if="canDownload(transfer)"
								class="btn btn-sm"
								:href="transfer.url"
								download
							>
								{{ transfer.status === "offered" ? "Download" : "Retry" }}
							</a>
							<button
								v-else-if="isActive(transfer)"
								class="btn btn-sm"
								@click="cancel(transfer.id)"
							>
								Cancel
							</button>
						</div>
					</li>
				</ul>
			</section>
		</div>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, onBeforeUnmount, onMounted, ref} from "vue";
import type {XdccTransfer, XdccTransferStatus} from "../../../shared/types/msg";
import fileTypeIcon from "../../js/helpers/fileTypeIcon";
import friendlysize from "../../js/helpers/friendlysize";
import socket from "../../js/socket";
import {useStore} from "../../js/store";
import SidebarToggle from "../SidebarToggle.vue";

const activeStatuses = new Set<XdccTransferStatus>(["connecting", "transferring"]);
const downloadableStatuses = new Set<XdccTransferStatus>(["offered", "failed", "cancelled"]);
const finishedStatuses = new Set<XdccTransferStatus>([
	"completed",
	"failed",
	"cancelled",
	"expired",
]);
const statusLabels: Record<XdccTransferStatus, string> = {
	offered: "Available",
	connecting: "Connecting",
	transferring: "Downloading",
	completed: "Completed",
	failed: "Failed",
	cancelled: "Cancelled",
	expired: "Expired",
};
const timeFormatter = new Intl.DateTimeFormat(undefined, {
	hour: "2-digit",
	minute: "2-digit",
});

export default defineComponent({
	name: "Transfers",
	components: {
		SidebarToggle,
	},
	setup() {
		const store = useStore();
		const now = ref(Date.now());
		let clock: ReturnType<typeof setInterval> | undefined;
		const isActive = (transfer: XdccTransfer) => activeStatuses.has(transfer.status);

		const transfers = computed(() =>
			[...store.state.xdccTransfers].sort((a, b) => {
				const activeDifference = Number(isActive(b)) - Number(isActive(a));
				return activeDifference || b.offeredAt - a.offeredAt;
			})
		);
		const activeCount = computed(
			() => transfers.value.filter((transfer) => isActive(transfer)).length
		);
		const hasFinishedTransfers = computed(() =>
			transfers.value.some((transfer) => finishedStatuses.has(transfer.status))
		);

		const canDownload = (transfer: XdccTransfer) =>
			downloadableStatuses.has(transfer.status) && transfer.expiresAt > now.value;
		const showProgress = (transfer: XdccTransfer) =>
			isActive(transfer) || transfer.received > 0 || transfer.status === "completed";

		const progressValue = (transfer: XdccTransfer) => {
			if (transfer.status === "completed" && transfer.size === undefined) {
				return 1;
			}

			return transfer.size === undefined
				? undefined
				: Math.min(transfer.received, transfer.size);
		};

		const formatDuration = (seconds: number) => {
			if (seconds < 60) {
				return `${Math.max(1, Math.ceil(seconds))}s`;
			}

			if (seconds < 3600) {
				return `${Math.ceil(seconds / 60)}m`;
			}

			return `${Math.ceil(seconds / 3600)}h`;
		};

		const formatTime = (timestamp: number) => timeFormatter.format(timestamp);
		const statusLabel = (transfer: XdccTransfer) => statusLabels[transfer.status];

		const statusDetail = (transfer: XdccTransfer) => {
			if (transfer.status === "offered") {
				return `Available for ${formatDuration((transfer.expiresAt - now.value) / 1000)}`;
			}

			if (transfer.status === "connecting") {
				return "Connecting to the sender…";
			}

			if (transfer.status === "transferring") {
				const progress =
					transfer.size === undefined
						? friendlysize(transfer.received)
						: `${friendlysize(transfer.received)} of ${friendlysize(transfer.size)}`;
				const speed = transfer.speed > 0 ? ` · ${friendlysize(transfer.speed)}/s` : "";
				const eta =
					transfer.size !== undefined && transfer.speed > 0
						? ` · ${formatDuration(
								(transfer.size - transfer.received) / transfer.speed
						  )} left`
						: "";

				return progress + speed + eta;
			}

			if (transfer.status === "completed") {
				return `${friendlysize(transfer.received)} downloaded`;
			}

			if (transfer.status === "failed") {
				return transfer.error || "The transfer failed.";
			}

			if (transfer.status === "cancelled") {
				return "Download cancelled.";
			}

			return "This offer is no longer available.";
		};

		const cancel = (id: string) => socket.emit("xdcc:cancel", {id});
		const clearFinished = () => store.commit("clearFinishedXdccTransfers");

		onMounted(() => {
			clock = setInterval(() => {
				now.value = Date.now();

				for (const transfer of store.state.xdccTransfers) {
					if (
						downloadableStatuses.has(transfer.status) &&
						transfer.expiresAt <= now.value
					) {
						store.commit("updateXdccTransfer", {
							id: transfer.id,
							status: "expired",
							received: transfer.received,
							speed: transfer.speed,
							error: undefined,
						});
					}
				}
			}, 1000);
		});

		onBeforeUnmount(() => {
			if (clock) {
				clearInterval(clock);
			}
		});

		return {
			activeCount,
			cancel,
			canDownload,
			clearFinished,
			fileTypeIcon,
			formatTime,
			hasFinishedTransfers,
			isActive,
			progressValue,
			showProgress,
			statusDetail,
			statusLabel,
			transfers,
		};
	},
});
</script>
