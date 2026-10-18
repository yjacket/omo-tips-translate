// Deterministic QA provider for the live replay. Translation requests arrive as a
// JSON object in the last user message; every value is mapped to "번역:" + value
// with its {n} tokens kept exactly. Chat turns get a plain delayed reply so the
// working tip stays on screen long enough to capture.
import {
	calculateCost,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";

const PROVIDER = "fake-translator";
const MODEL = "fake-translator-1";
const CHAT_DELAY_MS = 6000;
const TRANSLATE_DELAY_MS = 80;

type Message = { role?: string; content?: unknown };
type Context = { messages?: Message[] };

function lastUserText(messages: Message[] | undefined): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			return message.content
				.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
				.join("\n");
		}
	}
	return "";
}

function translateRequest(text: string): Record<string, string> | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value !== "string") return undefined;
			out[key] = `번역:${value}`;
		}
		return out;
	} catch {
		return undefined;
	}
}

function replyFor(context: Context): { text: string; translation: boolean } {
	const user = lastUserText(context.messages);
	const translated = translateRequest(user);
	if (translated) return { text: JSON.stringify(translated), translation: true };
	return { text: "fake provider reply", translation: false };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		const abort = () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

function streamFake(model: any, context: Context, options?: { signal?: AbortSignal }) {
	const stream = createAssistantMessageEventStream();
	const output: any = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};

	(async () => {
		try {
			stream.push({ type: "start", partial: output });
			void getCurrentSystemPrompt(context.messages);
			const reply = replyFor(context);
			await sleep(reply.translation ? TRANSLATE_DELAY_MS : CHAT_DELAY_MS, options?.signal);
			output.content.push({ type: "text", text: reply.text });
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			stream.push({ type: "text_delta", contentIndex: 0, delta: reply.text, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: reply.text, partial: output });
			output.stopReason = "stop";
			calculateCost(model, output.usage);
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

export default function fakeTranslator(pi: any): void {
	pi.registerProvider(PROVIDER, {
		name: "Fake Translator",
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "fake-key",
		api: "openai-completions",
		models: [
			{
				id: MODEL,
				name: "Fake Translator",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			},
		],
		streamSimple: streamFake,
	});
}
