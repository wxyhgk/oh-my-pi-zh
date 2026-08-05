/**
 * Render every built-in tool's renderer across its lifecycle states.
 */

import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { galleryHelp as commandHelp } from "../cli/command-help";
import { GALLERY_STATE_TOKENS, type GalleryState, parseGalleryStates, runGalleryCommand } from "../cli/gallery-cli";

export default class Gallery extends Command {
	static description = commandHelp.description;
	static flags = {
		tool: Flags.string({ char: "t", description: "按名称渲染单个工具" }),
		state: Flags.string({
			char: "s",
			description: "仅渲染给定的生命周期状态",
			options: GALLERY_STATE_TOKENS,
			multiple: true,
		}),
		width: Flags.integer({ char: "w", description: "渲染宽度（列数）" }),
		expanded: Flags.boolean({
			char: "e",
			description: "渲染每个渲染器的展开变体",
			default: false,
		}),
		plain: Flags.boolean({ description: "从输出中去除 ANSI 样式", default: false }),
		screenshot: Flags.boolean({
			description:
				"通过 VHS 将渲染输出捕获为 PNG 截图，而不是打印 ANSI（需要 vhs）",
			default: false,
		}),
		out: Flags.string({
			char: "o",
			description: "截图输出路径（配合 --screenshot）；拆分为多张图片时按序添加后缀",
		}),
		font: Flags.string({ description: "截图字体族（默认：JetBrainsMono Nerd Font）" }),
		"font-size": Flags.integer({ description: "截图字号（磅，默认：18）" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Gallery);
		let states: GalleryState[] | undefined;
		try {
			states = parseGalleryStates(flags.state);
		} catch (err) {
			process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
			process.exitCode = 1;
			return;
		}
		await runGalleryCommand({
			tool: flags.tool,
			states,
			width: flags.width,
			expanded: flags.expanded,
			plain: flags.plain,
			screenshot: flags.screenshot,
			out: flags.out,
			font: flags.font,
			fontSize: flags["font-size"],
		});
	}
}
