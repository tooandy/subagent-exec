import type {
  RpcEvent
} from "./rpc.js";

import type {
  UsageInfo
} from "./types.js";

function numberValue(
  value: unknown
): number | undefined {
  return typeof value === "number"
    ? value
    : undefined;
}

export function parseUsage(
  response: RpcEvent
): UsageInfo | undefined {
  /*
   * Pi RPC get_session_stats returns:
   * { data: { tokens: { input, output, cacheRead, cacheWrite, total }, cost } }
   */
  const respData =
    response.data ??
    response.stats ??
    response;

  if (
    !respData ||
    typeof respData !== "object"
  ) {
    return undefined;
  }

  const data = respData as Record<string, unknown>;

  /*
   * Tokens may be nested under tokens object.
   */
  const tokensObj =
    data.tokens &&
    typeof data.tokens === "object"
      ? data.tokens as Record<string, unknown>
      : data;

  const input =
    numberValue(tokensObj.input) ??
    numberValue(tokensObj.input_tokens) ??
    numberValue(tokensObj.inputTokens);

  const output =
    numberValue(tokensObj.output) ??
    numberValue(tokensObj.output_tokens) ??
    numberValue(tokensObj.outputTokens);

  const cacheRead =
    numberValue(tokensObj.cacheRead) ??
    numberValue(tokensObj.cache_read_tokens) ??
    numberValue(tokensObj.cacheReadTokens) ??
    0;

  const cacheWrite =
    numberValue(tokensObj.cacheWrite) ??
    numberValue(tokensObj.cache_write_tokens) ??
    numberValue(tokensObj.cacheWriteTokens) ??
    0;

  if (
    input === undefined &&
    output === undefined
  ) {
    return undefined;
  }

  const total =
    numberValue(tokensObj.total) ??
    numberValue(tokensObj.total_tokens) ??
    numberValue(tokensObj.totalTokens) ??
    (input ?? 0) + (output ?? 0) + cacheRead + cacheWrite;

  const cost = numberValue(data.cost);

  const currency =
    typeof data.currency === "string"
      ? data.currency
      : undefined;

  const result: UsageInfo = {
    input_tokens: input ?? 0,
    output_tokens: output ?? 0,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    total_tokens: total
  };

  if (cost !== undefined) {
    result.cost = cost;
  }

  if (currency) {
    result.currency = currency;
  }

  return result;
}
