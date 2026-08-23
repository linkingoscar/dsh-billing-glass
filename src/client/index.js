// dsh-billing-glass — 浏览器入口逻辑。构建脚本 scripts/build-client.js 会把它
// 与 src/client/* 打成 lib/client.js；用户安装仍是无构建的单一 bundle。
import { BillingGlassCard } from "./BillingGlassCard.js";
import { MessageCostChip } from "./MessageCostChip.js";
import { BillingGlassSettingsSection } from "./settings-section.js";

const inject = ["slots"];

/**
 * @param {{slots: {inject: (key: string, fn: () => void) => void, register: (descriptor: object, component: unknown) => void}}} ctx
 */
function apply(ctx) {
	ctx.slots.inject("shell.overlay", () => ctx.slots.register({
		name: "shell.overlay",
		id: "billing-glass",
		order: 100,
		label: "计费与余额"
	}, BillingGlassCard));
	ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register({
		name: "conversation.chat.assistant-actions",
		id: "billing-glass-cost",
		order: 20,
		label: "本消息费用"
	}, MessageCostChip));
	// 设置卡片（Harness v0.1.0-rc.7+；更早宿主静默等待声明，优雅降级）。
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: "billing-glass",
		order: 90,
		label: "计费悬浮卡"
	}, BillingGlassSettingsSection));
}

export const clientPlugin = { apply, inject };
