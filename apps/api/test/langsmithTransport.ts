/** Exercise the SDK's real JSON wire format (including its Uint8Array request bodies). */
export function captureTraceTransport() {
  const sent: { method: string; url: string; body: any }[] = [];
  const fetchImplementation: typeof fetch = async (url, init) => {
    const body =
      typeof init?.body === "string"
        ? init.body
        : new TextDecoder().decode(init?.body as Uint8Array);
    sent.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: JSON.parse(body),
    });
    return new Response("{}", { status: 200 });
  };
  return { sent, fetchImplementation };
}
