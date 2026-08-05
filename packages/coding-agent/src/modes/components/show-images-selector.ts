import { Container, type SelectItem, SelectList, type SgrMouseEvent } from "@wxyhgk/pi-tui";
import { getSelectListTheme } from "../../modes/theme/theme";
import { DynamicBorder } from "./dynamic-border";
import { routeSelectListMouseWithTopBorder } from "./select-list-mouse-routing";

/**
 * Component that renders a show images selector with borders
 */
export class ShowImagesSelectorComponent extends Container {
	#selectList: SelectList;

	constructor(currentValue: boolean, onSelect: (show: boolean) => void, onCancel: () => void) {
		super();

		const items: SelectItem[] = [
			{ value: "yes", label: "是", description: "在终端内联显示图片" },
			{ value: "no", label: "否", description: "改为显示文本占位符" },
		];

		// Add top border
		this.addChild(new DynamicBorder());

		// Create selector
		this.#selectList = new SelectList(items, 5, getSelectListTheme());

		// Preselect current value
		this.#selectList.setSelectedIndex(currentValue ? 0 : 1);

		this.#selectList.onSelect = item => {
			onSelect(item.value === "yes");
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
