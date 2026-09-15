import type { TWebSearchInput as WebSearchInput, TWebSearchResponse as WebSearchResponse } from "@warmap/contracts";

export type WebSearchAdapter = {
  search(input: WebSearchInput, signal: AbortSignal): Promise<WebSearchResponse>;
};

export const unavailableWebSearchAdapter: WebSearchAdapter = {
  async search() {
    throw new Error("Web Search provider is not configured; real provider is delivered by Ticket 16");
  },
};
