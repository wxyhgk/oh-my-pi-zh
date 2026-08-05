import { Container, type SelectItem, SelectList, type SgrMouseEvent } from "@oh-my-pi/pi-tui";
import { getSelectListTheme } from "../../modes/theme/theme";
import { DynamicBorder } from "./dynamic-border";
import { routeSelectListMouseWithTopBorder } from "./select-list-mouse-routing";

/**
 * Component that renders a queue mode selector with borders
 */
export class QueueModeSelectorComponent extends Container {
	#selectList: SelectList;

	constructor(
		currentMode: "all" | "one-at-a-time",
		onSelect: (mode: "all" | "one-at-a-time") => void,
		onCancel: () => void,
	) {
		super();

		const queueModes: SelectItem[] = [
			{
				value: "one-at-a-time",
				label: "one-at-a-time",
				description: "逐条处理排队消息(推荐)",
			},
			{ value: "all", label: "all", description: "一次处理所有排队消息" },
		];

		// Add top border
		this.addChild(new DynamicBorder());

		// Create selector
		this.#selectList = new SelectList(queueModes, 2, getSelectListTheme());

		// Preselect current mode
		const currentIndex = queueModes.findIndex(item => item.value === currentMode);
		if (currentIndex !== -1) {
			this.#selectList.setSelectedIndex(currentIndex);
		}

		this.#selectList.onSelect = item => {
			onSelect(item.value as "all" | "one-at-a-time");
		};

		this.#selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.#selectList);

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}
