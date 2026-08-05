import { Container, type SelectItem, SelectList, type SgrMouseEvent, Spacer, TruncatedText } from "@oh-my-pi/pi-tui";
import { getSelectListTheme, theme } from "../../modes/theme/theme";
import type { SessionPinAccount } from "../../slash-commands/helpers/session-pin";
import { DynamicBorder } from "./dynamic-border";

const ACCOUNT_SELECTOR_MAX_VISIBLE = 10;
const ACCOUNT_LIST_ROW_OFFSET = 4;

/** Account picker opened by `/session pin` for the current model provider. */
export class SessionAccountSelectorComponent extends Container {
	#selectList: SelectList;

	constructor(
		providerName: string,
		accounts: readonly SessionPinAccount[],
		onSelect: (account: SessionPinAccount) => void,
		onCancel: () => void,
	) {
		super();
		const accountsByValue = new Map<string, SessionPinAccount>();
		const items: SelectItem[] = accounts.map(account => {
			const value = String(account.credentialId);
			accountsByValue.set(value, account);
			return {
				value,
				label: account.label,
				description: account.active ? "本会话使用中" : undefined,
			};
		});

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.bold(`为当前会话选择 ${providerName} 账户:`)));
		this.addChild(new Spacer(1));

		this.#selectList = new SelectList(
			items,
			Math.min(Math.max(items.length, 1), ACCOUNT_SELECTOR_MAX_VISIBLE),
			getSelectListTheme(),
		);
		const activeIndex = accounts.findIndex(account => account.active);
		if (activeIndex >= 0) this.#selectList.setSelectedIndex(activeIndex);
		this.#selectList.onSelect = item => {
			const account = accountsByValue.get(item.value);
			if (account) onSelect(account);
		};
		this.#selectList.onCancel = onCancel;
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	/** Forward keyboard navigation and cancellation when the wrapper owns focus. */
	handleInput(keyData: string): void {
		this.#selectList.handleInput(keyData);
	}

	/** Route mouse selection through the title rows into the account list. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.#selectList.routeMouse(event, line - ACCOUNT_LIST_ROW_OFFSET, col);
	}
}
