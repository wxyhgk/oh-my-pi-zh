import * as fs from "node:fs";
import { $env } from "@oh-my-pi/pi-utils";
import { hasConfiguredAwsProfile } from "../utils/aws-profile";
import { AUTHENTICATED_SENTINEL } from "./types";

export interface AwsBedrockProviderOptions extends Readonly<Record<string, unknown>> {
	/** AWS region used in the service endpoint and SigV4 credential scope. */
	region?: string;
	/** Named AWS shared-credentials/config profile. */
	profile?: string;
	/** Amazon Bedrock API key sent as a bearer token, ahead of SigV4 credential resolution. */
	bearerToken?: string;
}

function isEc2Host(): boolean {
	for (const candidate of [
		"/sys/hypervisor/uuid",
		"/sys/devices/virtual/dmi/id/product_uuid",
		"/sys/devices/virtual/dmi/id/board_asset_tag",
	]) {
		try {
			const value = fs.readFileSync(candidate, "utf8").trim().toLowerCase();
			if (value.startsWith("ec2")) return true;
		} catch {
			// Missing/unreadable DMI metadata means this probe is inconclusive.
		}
	}
	return false;
}

export function hasAwsCredentialSource(): boolean {
	const hasEcsCredentials = !!$env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || !!$env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
	const hasWebIdentity = !!$env.AWS_WEB_IDENTITY_TOKEN_FILE && !!$env.AWS_ROLE_ARN;
	const hasProfile = hasConfiguredAwsProfile();
	const hasInstanceRole =
		$env.AWS_EC2_METADATA_DISABLED?.toLowerCase() !== "true" &&
		(!!$env.AWS_EC2_METADATA_SERVICE_ENDPOINT || isEc2Host());
	return !!(
		($env.AWS_ACCESS_KEY_ID && $env.AWS_SECRET_ACCESS_KEY) ||
		$env.AWS_BEARER_TOKEN_BEDROCK ||
		hasWebIdentity ||
		hasProfile ||
		hasEcsCredentials ||
		hasInstanceRole
	);
}

/** Registry key marker for AWS transports that resolve their own bearer/IAM credentials. */
export function resolveAwsRegistryApiKey(): string | undefined {
	return hasAwsCredentialSource() ? AUTHENTICATED_SENTINEL : undefined;
}

/** Resolve a real AWS bearer token while filtering the registry's auth marker. */
export function resolveAwsBearerToken(apiKey?: string, bearerToken?: string): string | undefined {
	const resolvedApiKey = apiKey === AUTHENTICATED_SENTINEL ? undefined : apiKey;
	return bearerToken || resolvedApiKey || $env.AWS_BEARER_TOKEN_BEDROCK;
}
