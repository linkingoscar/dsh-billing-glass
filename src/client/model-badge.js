// 型号代称：把模型名折叠成短标签（fail-soft 的展示层逻辑）。

		/** 根据供应商与模型名生成一个简短型号代称（如 DeepSeek Pro/Flash、K2.5、5.6-Sol、Opus-4）。 */
		export function modelBadgeFor(provider, model) {
			if (typeof model !== "string" || model === "") return null;
			const text = model;
			const lower = text.toLowerCase();
			const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

			const isDeepSeek = provider?.id === "deepseek" || lower.includes("deepseek");
			if (isDeepSeek) {
				if (/(^|[^a-z0-9])pro([^a-z0-9]|$)/i.test(text)) return "Pro";
				if (/(^|[^a-z0-9])flash([^a-z0-9]|$)/i.test(text)) return "Flash";
			}

			// Kimi：kimi-k2.5 -> K2.5，kimi-k2.7-code -> K2.7-Code，kimi-k3 -> K3
			const kimi = lower.match(/kimi-?k?(\d+(?:\.\d+)?)(?:-([a-z0-9]+))?/);
			if (kimi) {
				const suffix = kimi[2];
				const suffixLabel = ({ code: "Code", thinking: "Think", turbo: "Turbo", preview: "Preview", highspeed: "HighSpeed" })[suffix];
				return `K${kimi[1]}${suffixLabel ? `-${suffixLabel}` : ""}`;
			}

			// GPT：gpt-5.6-luna -> 5.6-Luna，gpt-5.2-pro -> 5.2-Pro，gpt-4o -> 4o
			if (lower.includes("gpt")) {
				const gpt = lower.match(/gpt[-/]?(\d+(?:\.\d+)?o?)(?:[-/]([a-z0-9]+))?/);
				if (gpt) {
					const version = gpt[1];
					const variant = gpt[2];
					const variantLabel = variant ? cap(variant) : null;
					if (variant && ["sol", "tera", "luna", "lunar"].includes(variant)) return `${version}-${variantLabel}`;
					const knownVariant = ({ turbo: "Turbo", mini: "Mini", pro: "Pro", nano: "Nano", max: "Max", codex: "Codex", audio: "Audio", chat: "Chat", oss: "OSS", latest: "Latest" })[variant];
					if (knownVariant) return `${version}-${knownVariant}`;
					return version;
				}
				if (/\bgpt-oss\b/i.test(text)) return "OSS";
				if (/\bgpt-audio\b/i.test(text)) return "Audio";
				if (/\bgpt-chat\b/i.test(text)) return "Chat";
			}

			// Claude：claude-opus-4 -> Opus-4，claude-haiku-4.5 -> Haiku-4.5
			if (lower.includes("claude")) {
				const tier = text.match(/(opus|sonnet|haiku|fable)/i)?.[1];
				const version = text.match(/claude[^0-9]*(\d+(?:\.\d+)?)/i)?.[1];
				const tierLabel = tier ? cap(tier) : "Claude";
				return version ? `${tierLabel}-${version}` : tierLabel;
			}

			// Gemini：gemini-2.5-pro -> 2.5-Pro，gemini-3-flash -> 3-Flash
			if (lower.includes("gemini")) {
				const version = text.match(/gemini[-/]?(\d+(?:\.\d+)?)/i)?.[1];
				const tier = text.match(/(pro|flash|lite)/i)?.[1];
				const tierLabel = tier ? cap(tier) : null;
				if (version && tierLabel) return `${version}-${tierLabel}`;
				if (version) return version;
				return tierLabel ?? "Gemini";
			}

			// Qwen：qwen3.7-max -> 3.7-Max，qwen-plus -> Plus
			if (lower.includes("qwen")) {
				const version = text.match(/qwen[-/]?(\d+(?:\.\d+)?)/i)?.[1];
				const tier = text.match(/(max|plus|pro|flash|lite|turbo|coder|thinking|vl)/i)?.[1];
				const tierLabel = tier ? (tier === "vl" ? "VL" : cap(tier)) : null;
				if (version && tierLabel) return `${version}-${tierLabel}`;
				if (version) return version;
				return tierLabel ?? "Qwen";
			}

			// GLM：glm-5.2 -> 5.2，glm-4.7-flash -> 4.7-Flash
			if (lower.includes("glm")) {
				const version = text.match(/glm[-/]?(\d+(?:\.\d+)?)/i)?.[1];
				const variant = text.match(/(air|flash|turbo|plus|pro|v)/i)?.[1];
				const variantLabel = variant ? (variant === "v" ? "V" : cap(variant)) : null;
				if (version && variantLabel) return `${version}-${variantLabel}`;
				if (version) return version;
				return variantLabel ?? "GLM";
			}

			const tiers = [
				["pro", "Pro"], ["flash", "Flash"], ["lite", "Lite"], ["mini", "Mini"],
				["nano", "Nano"], ["max", "Max"], ["ultra", "Ultra"], ["turbo", "Turbo"],
				["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"],
				["thinking", "Thinking"], ["code", "Code"], ["preview", "Preview"]
			];
			for (const [token, label] of tiers) {
				if (new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, "i").test(text)) return label;
			}
			const series = [
				["kimi", "Kimi"], ["glm", "GLM"], ["qwen", "Qwen"], ["gpt", "GPT"],
				["gemini", "Gemini"], ["gemma", "Gemma"], ["claude", "Claude"],
				["llama", "Llama"], ["mistral", "Mistral"], ["mixtral", "Mistral"],
				["ministral", "Mistral"], ["codestral", "Mistral"], ["devstral", "Mistral"],
				["voxtral", "Mistral"], ["grok", "Grok"], ["mimo", "MiMo"],
				["minimax", "MM"], ["nemotron", "Nemo"], ["deepseek", "DeepSeek"],
				["ling", "Ling"], ["ring", "Ring"], ["step", "Step"],
				["north", "North"], ["laguna", "Laguna"], ["seed", "Seed"],
				["nova", "Nova"], ["command", "Command"], ["jamba", "Jamba"],
				["granite", "Granite"], ["inkling", "Inkling"], ["auto", "Auto"],
				["hy3", "Hunyuan"], ["solar", "Solar"], ["mercury", "Mercury"],
				["aion", "Aion"], ["muse", "Muse"], ["trinity", "Trinity"],
				["virtuoso", "Virtuoso"], ["kat", "Kat"], ["longcat", "LongCat"],
				["free", "Free"]
			];
			for (const [token, label] of series) {
				if (new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, "i").test(text)) return label;
			}
			return null;
		}
