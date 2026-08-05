/**
 * Synthesize text with the local TTS engine and play it (or save it with --out).
 *
 * Text comes from the argument or --file. Input is segmented into
 * sentence-sized chunks ({@link SpeakableStream}) and synthesized through the
 * streaming TTS worker, so arbitrarily long text plays gaplessly instead of
 * hitting Kokoro's single-call ~510-phoneme truncation. --out concatenates the
 * streamed segments into one WAV. The first run downloads the configured local
 * model into the worker's cache.
 */

import { getProjectDir } from "@wxyhgk/pi-utils";
import { Args, Command, Flags } from "@wxyhgk/pi-utils/cli";
import chalk from "chalk";
import { sayHelp as commandHelp } from "../cli/command-help";
import { Settings, settings } from "../config/settings";
import { TTS_LOCAL_VOICE_VALUES } from "../tts/models";
import { SpeakableStream } from "../tts/speakable";
import { StreamingAudioPlayer } from "../tts/streaming-player";
import { shutdownTtsClient, ttsClient } from "../tts/tts-client";
import { encodeWav } from "../tts/wav";

export default class Say extends Command {
	static description = commandHelp.description;
	static args = {
		text: Args.string({ description: "要朗读的文本（或使用 --file）" }),
	};

	static flags = {
		voice: Flags.string({ description: "音色 ID", options: TTS_LOCAL_VOICE_VALUES }),
		model: Flags.string({ description: "本地 TTS 模型键" }),
		file: Flags.string({ char: "f", description: "从此文件读取要朗读的文本" }),
		out: Flags.string({ char: "o", description: "将 WAV 写入此路径而不是播放" }),
	};

	static examples = [
		'omp-zh say "hello world"',
		"omp-zh say --file notes.md --voice bm_fable",
		'omp-zh say "hello world" --out /tmp/hello.wav',
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Say);
		if (args.text && flags.file) {
			process.stderr.write(chalk.red("错误：请只传入 text 或 --file 之一，不要同时传入\n"));
			process.exit(1);
		}

		await Settings.init({ cwd: getProjectDir() });
		const model = flags.model ?? settings.get("tts.localModel");
		const voice = flags.voice ?? settings.get("tts.localVoice");

		let exitCode = 0;
		const unsubscribe = ttsClient.onProgress(event => {
			if (event.status === "progress" && typeof event.progress === "number") {
				process.stderr.write(`\r${chalk.dim(`正在下载 ${event.file ?? model}：${Math.round(event.progress)}%`)}`);
			} else if (event.status === "done" || event.status === "ready") {
				// Clear the progress line once the download finishes.
				process.stderr.write("\r\x1b[K");
			}
		});

		try {
			const text = flags.file ? await Bun.file(flags.file).text() : (args.text ?? "");
			const splitter = new SpeakableStream();
			const segments = [...splitter.push(text), ...splitter.flush()];
			if (segments.length === 0) {
				process.stderr.write(chalk.red("错误：输入中没有可朗读的内容\n"));
				exitCode = 1;
				return;
			}

			const stream = ttsClient.synthesizeStream(model, { voice });
			for (const segment of segments) stream.push(segment);
			stream.end();

			if (flags.out) {
				const pcms: Float32Array[] = [];
				let total = 0;
				let sampleRate = 0;
				for await (const chunk of stream.chunks) {
					pcms.push(chunk.pcm);
					total += chunk.pcm.length;
					sampleRate = chunk.sampleRate;
				}
				if (total === 0) {
					this.#synthesisFailed(model);
					exitCode = 1;
					return;
				}
				const pcm = new Float32Array(total);
				let offset = 0;
				for (const part of pcms) {
					pcm.set(part, offset);
					offset += part.length;
				}
				const wav = encodeWav(pcm, sampleRate);
				await Bun.write(flags.out, wav);
				const durationSec = total / sampleRate;
				process.stdout.write(
					`${chalk.green("已保存")} ${flags.out} ` +
						`${chalk.dim(`(${voice}, ${model}, ${durationSec.toFixed(1)}s, ${wav.byteLength} bytes)`)}\n`,
				);
				return;
			}

			const player = new StreamingAudioPlayer();
			let spoken = 0;
			let seconds = 0;
			for await (const chunk of stream.chunks) {
				player.start(chunk.sampleRate);
				player.write(chunk.pcm);
				spoken++;
				seconds += chunk.pcm.length / chunk.sampleRate;
			}
			if (spoken === 0) {
				player.stop();
				this.#synthesisFailed(model);
				exitCode = 1;
				return;
			}
			await player.end();
			process.stdout.write(
				`${chalk.green("已朗读")} ${chalk.dim(`(${voice}, ${model}, ${seconds.toFixed(1)}s, ${spoken} segments)`)}\n`,
			);
		} catch (err) {
			process.stderr.write(chalk.red(`错误：${err instanceof Error ? err.message : String(err)}\n`));
			exitCode = 1;
		} finally {
			unsubscribe();
			await shutdownTtsClient();
		}

		if (exitCode !== 0) process.exit(exitCode);
	}

	#synthesisFailed(model: string): void {
		process.stderr.write(
			chalk.red(`错误：无法使用本地 TTS 模型 "${model}" 合成语音。请运行 \`omp-zh setup speech\` 安装它。\n`),
		);
	}
}
