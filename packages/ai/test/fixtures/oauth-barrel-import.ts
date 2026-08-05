import {
	AnthropicOAuthFlow as RootAnthropicOAuthFlow,
	loginAnthropic as rootLoginAnthropic,
	refreshAnthropicToken as rootRefreshAnthropicToken,
} from "@oh-my-pi/pi-ai";
import {
	AnthropicOAuthFlow as OAuthAnthropicOAuthFlow,
	loginAnthropic as oauthLoginAnthropic,
	refreshAnthropicToken as oauthRefreshAnthropicToken,
} from "@oh-my-pi/pi-ai/registry/oauth";
import "@oh-my-pi/pi-ai/providers/anthropic";
import "@oh-my-pi/pi-ai/auth-storage";

const publicExports = [
	RootAnthropicOAuthFlow,
	rootLoginAnthropic,
	rootRefreshAnthropicToken,
	OAuthAnthropicOAuthFlow,
	oauthLoginAnthropic,
	oauthRefreshAnthropicToken,
];

if (publicExports.some(value => !value)) {
	throw new Error("Anthropic OAuth exports are unavailable");
}
