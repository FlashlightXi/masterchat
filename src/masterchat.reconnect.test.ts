import { AccessDeniedError, DisconnectedError } from "./errors";
import { ChatResponse } from "./interfaces";
import {
  IterateChatOptions,
  IterateDisconnectEvent,
  Masterchat,
} from "./masterchat";

function chatResponse(continuation?: string): ChatResponse {
  return {
    actions: [],
    continuation: continuation
      ? {
          token: continuation,
          timeoutMs: 0,
        }
      : undefined,
    error: null,
  };
}

async function collect(mc: Masterchat, options: IterateChatOptions = {}) {
  const responses: ChatResponse[] = [];
  for await (const response of mc.iterate(options)) {
    responses.push(response);
  }
  return responses;
}

describe("iterate reconnect", () => {
  it("stops after a disconnect unless reconnect is enabled", async () => {
    const mc = new Masterchat("video", "channel", { mode: "live" });
    const disconnects: IterateDisconnectEvent[] = [];
    const error = new DisconnectedError("stalled");

    jest.spyOn(mc, "fetch").mockRejectedValueOnce(error);

    await expect(
      collect(mc, {
        onDisconnect: (event) => {
          disconnects.push(event);
        },
      })
    ).rejects.toBe(error);

    expect(disconnects).toEqual([
      expect.objectContaining({
        error,
        reason: "stalled",
        willReconnect: false,
      }),
    ]);
  });

  it("resumes with the latest continuation token after a recoverable error", async () => {
    const mc = new Masterchat("video", "channel", { mode: "live" });
    const disconnects: IterateDisconnectEvent[] = [];
    const error = new Error("socket closed");
    const fetch = jest
      .spyOn(mc, "fetch")
      .mockResolvedValueOnce(chatResponse("latest-token"))
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(chatResponse());

    const responses = await collect(mc, {
      reconnect: { retry: 1, retryInterval: 0 },
      onDisconnect: (event) => {
        disconnects.push(event);
      },
    });

    expect(responses).toHaveLength(2);
    expect(fetch.mock.calls).toEqual([
      [{ top: false }],
      ["latest-token"],
      ["latest-token"],
    ]);
    expect(disconnects).toEqual([
      expect.objectContaining({
        error,
        reason: "fetch-error",
        willReconnect: true,
        reconnectAttempt: 1,
        retryAfterMs: 0,
      }),
    ]);
  });

  it("throws after the configured number of consecutive reconnect failures", async () => {
    const mc = new Masterchat("video", "channel", { mode: "live" });
    const fetch = jest
      .spyOn(mc, "fetch")
      .mockRejectedValue(new DisconnectedError("stalled"));

    await expect(
      collect(mc, { reconnect: { retry: 2, retryInterval: 0 } })
    ).rejects.toBeInstanceOf(DisconnectedError);

    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-recoverable masterchat errors", async () => {
    const mc = new Masterchat("video", "channel", { mode: "live" });
    const fetch = jest
      .spyOn(mc, "fetch")
      .mockRejectedValue(new AccessDeniedError("denied"));

    await expect(collect(mc, { reconnect: true })).rejects.toBeInstanceOf(
      AccessDeniedError
    );

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
